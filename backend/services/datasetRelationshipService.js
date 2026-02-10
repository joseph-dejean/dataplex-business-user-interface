const { Firestore } = require('@google-cloud/firestore');

// Lazy Firestore initialization
let firestore = null;
const getFirestore = () => {
    if (!firestore) {
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
        firestore = new Firestore(projectId ? { projectId } : {});
        console.log('Firestore initialized for dataset relationships, project:', projectId || 'auto-detect');
    }
    return firestore;
};

const COLLECTION_NAME = 'dataset-relationships';
const CACHE_TTL_HOURS = 24; // Cache for 24 hours

/**
 * Infer relationships between tables based on column naming conventions.
 * Looks for patterns like:
 * - customer_id in order_item → likely references customer table
 * - user_key in sessions → likely references user table
 * - product_fk in order_line → likely references product table
 *
 * @param {Array} tables - Array of table objects with name and schema
 * @returns {Array} - Array of {table1, table2, relationship, confidence}
 */
const inferRelationships = (tables) => {
    const relationships = [];
    const tableNames = new Set(tables.map(t => t.name.toLowerCase()));

    // Common FK patterns: {column_suffix} → {table_name}
    const fkPatterns = [
        { suffix: '_id', confidence: 'high' },
        { suffix: '_key', confidence: 'medium' },
        { suffix: '_fk', confidence: 'high' },
        { suffix: '_ref', confidence: 'medium' },
        { suffix: 'id', confidence: 'low' }, // e.g., customerid without underscore
    ];

    for (const table of tables) {
        if (!table.schema || !Array.isArray(table.schema)) continue;

        for (const column of table.schema) {
            const colName = (column.name || '').toLowerCase();

            for (const pattern of fkPatterns) {
                if (colName.endsWith(pattern.suffix)) {
                    // Extract potential referenced table name
                    // e.g., "customer_id" → "customer"
                    let refTableName = colName.slice(0, -pattern.suffix.length);

                    // Handle plurals: "customers_id" → "customer" or "customers"
                    const refTableNamePlural = refTableName + 's';
                    const refTableNameSingular = refTableName.endsWith('s')
                        ? refTableName.slice(0, -1)
                        : refTableName;

                    // Check if referenced table exists
                    let matchedTable = null;
                    if (tableNames.has(refTableName)) {
                        matchedTable = refTableName;
                    } else if (tableNames.has(refTableNamePlural)) {
                        matchedTable = refTableNamePlural;
                    } else if (tableNames.has(refTableNameSingular)) {
                        matchedTable = refTableNameSingular;
                    }

                    if (matchedTable && matchedTable !== table.name.toLowerCase()) {
                        // Find the actual table name with correct casing
                        const actualRefTable = tables.find(t =>
                            t.name.toLowerCase() === matchedTable
                        );

                        if (actualRefTable) {
                            // Avoid duplicates
                            const exists = relationships.some(r =>
                                (r.table1 === table.name && r.table2 === actualRefTable.name) ||
                                (r.table1 === actualRefTable.name && r.table2 === table.name)
                            );

                            if (!exists) {
                                relationships.push({
                                    table1: actualRefTable.name, // Referenced table (parent)
                                    table2: table.name,          // Referencing table (child)
                                    relationship: `${column.name}`,
                                    confidence: pattern.confidence,
                                    columnType: column.type || 'unknown'
                                });
                            }
                        }
                    }
                    break; // Found a match, no need to check other patterns
                }
            }
        }
    }

    return relationships;
};

/**
 * Get cached relationships from Firestore
 */
const getCachedRelationships = async (projectId, datasetId) => {
    try {
        const db = getFirestore();
        const cacheKey = `${projectId}.${datasetId}`;
        const docRef = db.collection(COLLECTION_NAME).doc(cacheKey);
        const doc = await docRef.get();

        if (!doc.exists) {
            return null;
        }

        const data = doc.data();
        const cachedAt = data.cachedAt?.toDate ? data.cachedAt.toDate() : new Date(data.cachedAt);
        const now = new Date();
        const hoursSinceCached = (now - cachedAt) / (1000 * 60 * 60);

        if (hoursSinceCached > CACHE_TTL_HOURS) {
            console.log(`[RELATIONSHIPS] Cache expired for ${cacheKey} (${hoursSinceCached.toFixed(1)}h old)`);
            return null;
        }

        console.log(`[RELATIONSHIPS] Cache hit for ${cacheKey} (${hoursSinceCached.toFixed(1)}h old)`);
        return data.relationships;
    } catch (error) {
        console.warn('[RELATIONSHIPS] Cache read error:', error.message);
        return null;
    }
};

/**
 * Store relationships in Firestore cache
 */
const cacheRelationships = async (projectId, datasetId, relationships, tables) => {
    try {
        const db = getFirestore();
        const cacheKey = `${projectId}.${datasetId}`;
        const docRef = db.collection(COLLECTION_NAME).doc(cacheKey);

        await docRef.set({
            projectId,
            datasetId,
            relationships,
            tableCount: tables.length,
            tableNames: tables.map(t => t.name),
            cachedAt: new Date().toISOString(),
            inferredAt: new Date().toISOString()
        });

        console.log(`[RELATIONSHIPS] Cached ${relationships.length} relationships for ${cacheKey}`);
    } catch (error) {
        console.warn('[RELATIONSHIPS] Cache write error:', error.message);
    }
};

/**
 * Invalidate cache for a dataset (call when schema changes)
 */
const invalidateCache = async (projectId, datasetId) => {
    try {
        const db = getFirestore();
        const cacheKey = `${projectId}.${datasetId}`;
        await db.collection(COLLECTION_NAME).doc(cacheKey).delete();
        console.log(`[RELATIONSHIPS] Cache invalidated for ${cacheKey}`);
    } catch (error) {
        console.warn('[RELATIONSHIPS] Cache invalidate error:', error.message);
    }
};

/**
 * Add a manual relationship (user-defined)
 */
const addManualRelationship = async (projectId, datasetId, relationship) => {
    try {
        const db = getFirestore();
        const cacheKey = `${projectId}.${datasetId}`;
        const docRef = db.collection(COLLECTION_NAME).doc(cacheKey);
        const doc = await docRef.get();

        let relationships = [];
        if (doc.exists) {
            relationships = doc.data().relationships || [];
        }

        // Add manual relationship with flag
        relationships.push({
            ...relationship,
            confidence: 'manual',
            addedAt: new Date().toISOString()
        });

        await docRef.set({
            projectId,
            datasetId,
            relationships,
            cachedAt: new Date().toISOString()
        }, { merge: true });

        return relationships;
    } catch (error) {
        console.error('[RELATIONSHIPS] Add manual relationship error:', error.message);
        throw error;
    }
};

module.exports = {
    inferRelationships,
    getCachedRelationships,
    cacheRelationships,
    invalidateCache,
    addManualRelationship,
    CACHE_TTL_HOURS
};
