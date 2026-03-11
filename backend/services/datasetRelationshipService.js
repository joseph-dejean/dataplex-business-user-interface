const { Firestore } = require('@google-cloud/firestore');
const { CatalogServiceClient, protos } = require('@google-cloud/dataplex');
const { GoogleAuth } = require('google-auth-library');

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
const CACHE_TTL_HOURS = 24;

let catalogClient = null;
const getCatalogClient = () => {
    if (!catalogClient) {
        catalogClient = new CatalogServiceClient();
    }
    return catalogClient;
};

let authClient = null;
const getAuthClient = async () => {
    if (!authClient) {
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        authClient = await auth.getClient();
    }
    return authClient;
};

const parseFqn = (fqn) => {
    const clean = fqn.replace('bigquery:', '').replace('bigquery://', '');
    const parts = clean.split('.');
    if (parts.length >= 3) {
        return { project: parts[0], dataset: parts[1], table: parts[2] };
    }
    return null;
};

/**
 * Trigger DataScan with dataDocumentationSpec via REST API.
 */
const triggerDocumentationScan = async (billingProject, location, bqProject, bqDataset, bqTable) => {
    try {
        const client = await getAuthClient();
        const baseScanId = `doc-scan-${bqProject}-${bqDataset}-${bqTable}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        // ensure valid id
        const dataScanId = baseScanId.length > 63 ? baseScanId.substring(0, 63) : baseScanId;

        const url = `https://dataplex.googleapis.com/v1/projects/${billingProject}/locations/${location}/dataScans?dataScanId=${dataScanId}`;
        console.log(`[RELATIONSHIPS] Triggering DataScan (Discovery Phase) for ${bqProject}.${bqDataset}.${bqTable}: ${dataScanId}`);

        await client.request({
            url,
            method: 'POST',
            data: {
                data: {
                    resource: `//bigquery.googleapis.com/projects/${bqProject}/datasets/${bqDataset}/tables/${bqTable}`
                },
                dataDocumentationSpec: {},
                executionSpec: {
                    trigger: { onDemand: {} }
                }
            }
        });

        console.log(`[RELATIONSHIPS] DataScan created successfully for ${bqTable}`);
    } catch (err) {
        if (err.response && err.response.status === 409) {
            console.log(`[RELATIONSHIPS] DataScan ALREADY EXISTS for ${bqTable}. Ensure it has run.`);
            // if we wanted to be robust, we'd trigger a run via POST .../dataScans/{id}:run here
        } else {
            console.warn(`[RELATIONSHIPS] Error creating DataScan for ${bqTable}:`, err.response ? JSON.stringify(err.response.data) : err.message);
        }
    }
};

/**
 * Implement a recursive lookup reading the Documentation Aspect from Dataplex Catalog.
 * up to maxDegree 3.
 */
const fetchRelationshipsFromCatalog = async (billingProject, location, rootTablesFqns, maxDegree = 3) => {
    const relationships = [];
    const visited = new Set();
    const queue = [];
    let scansTriggered = 0; // Track how many DataScans we had to trigger

    // Initialize queue with degree 0
    for (const fqn of rootTablesFqns) {
        const parsed = parseFqn(fqn);
        if (parsed) {
            queue.push({ ...parsed, degree: 0 });
            visited.add(`${parsed.project}.${parsed.dataset}.${parsed.table}`);
        }
    }

    const client = getCatalogClient();

    while (queue.length > 0) {
        const current = queue.shift();

        if (current.degree > maxDegree) continue;

        const entryName = `projects/${current.project}/locations/${location}/entryGroups/@bigquery/entries/bigquery_${current.project}_${current.dataset}_${current.table}`;
        console.log(`[RELATIONSHIPS] 3rd Degree Discovery: Fetching aspect for ${current.project}.${current.dataset}.${current.table} at degree ${current.degree}`);

        try {
            const [entry] = await client.getEntry({
                name: entryName,
                view: protos.google.cloud.dataplex.v1.EntryView.ALL
            });

            if (!entry || !entry.aspects) continue;

            const aspectKeys = Object.keys(entry.aspects);
            const docAspectKey = aspectKeys.find(k => k.includes('data_documentation') || k.includes('documentation'));

            if (docAspectKey && entry.aspects[docAspectKey]) {
                const docData = entry.aspects[docAspectKey].data;
                const fields = docData && docData.fields ? docData.fields : {};

                // Try to find related entities. Assuming the Gemini-powered scan puts them in a field like related_entities or similar
                let relatedEntities = null;
                if (fields.related_entities && fields.related_entities.listValue) {
                    relatedEntities = fields.related_entities.listValue.values;
                } else if (fields.relatedEntities && fields.relatedEntities.listValue) {
                    relatedEntities = fields.relatedEntities.listValue.values;
                } else {
                    // search by inspecting all keys
                    for (const key of Object.keys(fields)) {
                        if (key.toLowerCase().includes('related') && fields[key].listValue) {
                            relatedEntities = fields[key].listValue.values;
                            break;
                        }
                    }
                }

                if (relatedEntities && relatedEntities.length > 0) {
                    for (const ent of relatedEntities) {
                        const entFields = ent.structValue && ent.structValue.fields ? ent.structValue.fields : {};
                        const relatedTableFqn = (entFields.table && entFields.table.stringValue) || (entFields.entity && entFields.entity.stringValue) || (entFields.name && entFields.name.stringValue);
                        const relationshipDescription = (entFields.relationship && entFields.relationship.stringValue) || 'AI-Inferred Relationship';

                        if (relatedTableFqn) {
                            const parsedRel = parseFqn(relatedTableFqn);
                            if (parsedRel) {
                                // Add relationship
                                relationships.push({
                                    table1: current.table,
                                    table2: parsedRel.table,
                                    relationship: relationshipDescription,
                                    confidence: 'high (AI)',
                                    source: 'Dataplex Catalog DataDocumentation'
                                });

                                const relKey = `${parsedRel.project}.${parsedRel.dataset}.${parsedRel.table}`;
                                if (!visited.has(relKey) && current.degree < maxDegree) {
                                    visited.add(relKey);
                                    queue.push({ ...parsedRel, degree: current.degree + 1 });
                                }
                            }
                        }
                    }
                }
            } else {
                // Documentation aspect missing, trigger scan
                console.log(`[RELATIONSHIPS] No documentation aspect for ${current.table}, triggering DataScan...`);
                await triggerDocumentationScan(billingProject, location, current.project, current.dataset, current.table);
                scansTriggered++;
            }

        } catch (err) {
            if (err.code === 5 || (err.message && err.message.includes('NOT_FOUND'))) {
                // Table doesn't exist in catalog or name schema might be different.
                // We'll still try to trigger a scan for it since Dataplex DataScans can run on native BQ tables.
                await triggerDocumentationScan(billingProject, location, current.project, current.dataset, current.table);
                scansTriggered++;
            } else {
                console.warn(`[RELATIONSHIPS] Entry Fetch error for ${entryName}:`, err.message);
            }
        }
    }

    return { relationships, scansTriggered };
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

        if (!doc.exists) return null;

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
const cacheRelationships = async (projectId, datasetId, relationships, tablesCount) => {
    try {
        const db = getFirestore();
        const cacheKey = `${projectId}.${datasetId}`;
        const docRef = db.collection(COLLECTION_NAME).doc(cacheKey);

        await docRef.set({
            projectId,
            datasetId,
            relationships,
            tableCount: tablesCount,
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
        if (doc.exists) relationships = doc.data().relationships || [];

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
    fetchRelationshipsFromCatalog,
    getCachedRelationships,
    cacheRelationships,
    invalidateCache,
    addManualRelationship,
    CACHE_TTL_HOURS
};
