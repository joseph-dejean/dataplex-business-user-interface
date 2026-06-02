const { google } = require('googleapis');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { BigQuery } = require('@google-cloud/bigquery');

/**
 * In-memory cache of project IAM bindings to avoid hammering
 * cloudresourcemanager.projects.getIamPolicy. Without this, every access check
 * fired getIamPolicy 5 times (once per role) and the same project was re-fetched
 * for every table on screen, which triggers 429 rate-limit / quota errors. When
 * those errors made every role check return false, the user appeared to "lose
 * access to all tables" at once.
 */
const IAM_BINDINGS_TTL_MS = 5 * 60 * 1000;
const iamBindingsCache = new Map(); // projectId -> { bindings, expiresAt }

/**
 * A transient error is a temporary failure (rate limit, timeout, 5xx, network)
 * that should NOT be interpreted as "the user has no access". The data layer
 * (BigQuery) still enforces real access when the user actually queries, so for
 * these UI gating checks we fail OPEN on transient errors and let the user
 * through rather than hiding everything.
 */
const isTransientError = (error) => {
    const code = error?.code ?? error?.response?.status ?? error?.cause?.code;
    const numeric = typeof code === 'number' ? code : parseInt(code, 10);
    if (numeric === 429 || (numeric >= 500 && numeric <= 599)) return true;
    const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'];
    if (typeof code === 'string' && transientCodes.includes(code)) return true;
    const msg = (error?.message || '').toLowerCase();
    return msg.includes('rate limit') || msg.includes('quota') || msg.includes('timeout')
        || msg.includes('econnreset') || msg.includes('try again') || msg.includes('unavailable');
};

/**
 * A "definitive denial" means GCP told us the caller is not allowed to read the
 * IAM policy (403 / PERMISSION_DENIED). That is a real signal we can act on.
 */
const isPermissionDenied = (error) => {
    const code = error?.code ?? error?.response?.status;
    const numeric = typeof code === 'number' ? code : parseInt(code, 10);
    if (numeric === 403) return true;
    const msg = (error?.message || '').toLowerCase();
    return msg.includes('permission') && msg.includes('denied');
};

/**
 * Create a BigQuery client, optionally using a user's access token.
 * @param {string} projectId - The GCP Project ID.
 * @param {string} [userAccessToken] - Optional user OAuth access token.
 */
const createBigQueryClient = (projectId, userAccessToken) => {
    if (userAccessToken) {
        // Use user's OAuth token
        const oauth2Client = new OAuth2Client();
        oauth2Client.setCredentials({ access_token: userAccessToken });
        return new BigQuery({ projectId, authClient: oauth2Client });
    }
    // Fall back to ADC (service account)
    return new BigQuery({ projectId });
};

/**
 * Grant access to a user on a specific BigQuery dataset.
 * This is more granular than project-level IAM - users only get access to the specific dataset.
 *
 * @param {string} projectId - The GCP Project ID where the dataset lives.
 * @param {string} datasetId - The BigQuery dataset ID.
 * @param {string} email - The email of the user to grant access to.
 * @param {string} role - The BigQuery role (READER, WRITER, or OWNER). Defaults to READER.
 * @param {string} [userAccessToken] - Optional admin's OAuth token (if provided, uses user auth instead of service account).
 */
const grantDatasetAccess = async (projectId, datasetId, email, role = 'READER', userAccessToken = null) => {
    console.log(`[DATASET-ACCESS] Granting ${role} access: User=${email}, Dataset=${projectId}.${datasetId}`);
    console.log(`[DATASET-ACCESS] Using ${userAccessToken ? 'user OAuth token' : 'service account'}`);

    try {
        const bigquery = createBigQueryClient(projectId, userAccessToken);
        const dataset = bigquery.dataset(datasetId);

        // Get current dataset metadata
        const [metadata] = await dataset.getMetadata();
        const access = metadata.access || [];

        // Check if user already has access
        const member = `user:${email}`;
        const existingEntry = access.find(entry =>
            entry.userByEmail === email && entry.role === role
        );

        if (existingEntry) {
            console.log(`[DATASET-ACCESS] User ${email} already has ${role} access to ${datasetId}`);
            return true;
        }

        // Add new access entry
        access.push({
            role: role,
            userByEmail: email
        });

        // Update dataset with new access list
        metadata.access = access;
        await dataset.setMetadata(metadata);

        console.log(`[DATASET-ACCESS] Successfully granted ${role} access to ${email} on ${projectId}.${datasetId}`);
        return true;

    } catch (error) {
        console.error('[DATASET-ACCESS] Error granting dataset access:', error);
        throw new Error(`Failed to grant dataset access: ${error.message}`);
    }
};

/**
 * Revoke access from a user on a specific BigQuery dataset.
 *
 * @param {string} projectId - The GCP Project ID where the dataset lives.
 * @param {string} datasetId - The BigQuery dataset ID.
 * @param {string} email - The email of the user to revoke access from.
 * @param {string} role - The BigQuery role to revoke (READER, WRITER, or OWNER).
 * @param {string} [userAccessToken] - Optional admin's OAuth token (if provided, uses user auth instead of service account).
 */
const revokeDatasetAccess = async (projectId, datasetId, email, role = 'READER', userAccessToken = null) => {
    console.log(`[DATASET-ACCESS] Revoking ${role} access: User=${email}, Dataset=${projectId}.${datasetId}`);
    console.log(`[DATASET-ACCESS] Using ${userAccessToken ? 'user OAuth token' : 'service account'}`);

    try {
        const bigquery = createBigQueryClient(projectId, userAccessToken);
        const dataset = bigquery.dataset(datasetId);

        // Get current dataset metadata
        const [metadata] = await dataset.getMetadata();
        const access = metadata.access || [];

        // Find and remove the user's access entry
        const newAccess = access.filter(entry =>
            !(entry.userByEmail === email && entry.role === role)
        );

        if (newAccess.length === access.length) {
            console.log(`[DATASET-ACCESS] User ${email} doesn't have ${role} access to ${datasetId}`);
            return true;
        }

        // Update dataset with new access list
        metadata.access = newAccess;
        await dataset.setMetadata(metadata);

        console.log(`[DATASET-ACCESS] Successfully revoked ${role} access from ${email} on ${projectId}.${datasetId}`);
        return true;

    } catch (error) {
        console.error('[DATASET-ACCESS] Error revoking dataset access:', error);
        throw new Error(`Failed to revoke dataset access: ${error.message}`);
    }
};

/**
 * Grant access to a SINGLE BigQuery table (not the whole dataset).
 * Uses the table-level IAM policy so the user can only read the requested
 * table, not every table in the dataset.
 *
 * @param {string} projectId
 * @param {string} datasetId
 * @param {string} tableId
 * @param {string} email
 * @param {string} [role] - IAM role, defaults to roles/bigquery.dataViewer.
 * @param {string} [userAccessToken]
 */
/**
 * Get an authenticated transport client for BigQuery table IAM REST calls.
 * Uses the admin's OAuth token when provided, otherwise the service account.
 */
const getTableIamClient = async (userAccessToken) => {
    if (userAccessToken) {
        const oauth = new OAuth2Client();
        oauth.setCredentials({ access_token: userAccessToken });
        return oauth;
    }
    const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
    return auth.getClient();
};

const bqTableIamBase = (projectId, datasetId, tableId) =>
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}/tables/${encodeURIComponent(tableId)}`;

const grantTableAccess = async (projectId, datasetId, tableId, email, role = 'roles/bigquery.dataViewer', userAccessToken = null) => {
    console.log(`[TABLE-ACCESS] Granting ${role} on ${projectId}.${datasetId}.${tableId} to ${email}`);
    try {
        // The @google-cloud/bigquery Table object has no `.iam`; table-level IAM
        // is only available via the REST tables.getIamPolicy/setIamPolicy.
        const client = await getTableIamClient(userAccessToken);
        const base = bqTableIamBase(projectId, datasetId, tableId);

        const getResp = await client.request({
            url: `${base}:getIamPolicy`,
            method: 'POST',
            data: { options: { requestedPolicyVersion: 3 } },
        });
        const policy = getResp.data || {};
        policy.bindings = policy.bindings || [];
        const member = email.includes(':') ? email : `user:${email}`;

        let binding = policy.bindings.find(b => b.role === role && !b.condition);
        if (!binding) {
            binding = { role, members: [] };
            policy.bindings.push(binding);
        }
        binding.members = binding.members || [];
        if (binding.members.includes(member)) {
            console.log(`[TABLE-ACCESS] ${email} already has ${role} on ${tableId}`);
            return true;
        }
        binding.members.push(member);

        await client.request({ url: `${base}:setIamPolicy`, method: 'POST', data: { policy } });
        console.log(`[TABLE-ACCESS] Granted ${role} on ${tableId} to ${email}`);
        return true;
    } catch (error) {
        const detail = error.response?.data?.error?.message || error.message;
        console.error('[TABLE-ACCESS] Error granting table access:', detail);
        throw new Error(`Failed to grant table access: ${detail}`);
    }
};

/**
 * Revoke a user's access from a single BigQuery table (via REST table IAM).
 */
const revokeTableAccess = async (projectId, datasetId, tableId, email, role = 'roles/bigquery.dataViewer', userAccessToken = null) => {
    console.log(`[TABLE-ACCESS] Revoking ${role} on ${projectId}.${datasetId}.${tableId} from ${email}`);
    try {
        const client = await getTableIamClient(userAccessToken);
        const base = bqTableIamBase(projectId, datasetId, tableId);

        const getResp = await client.request({
            url: `${base}:getIamPolicy`,
            method: 'POST',
            data: { options: { requestedPolicyVersion: 3 } },
        });
        const policy = getResp.data || {};
        const member = email.includes(':') ? email : `user:${email}`;
        let changed = false;
        for (const binding of policy.bindings || []) {
            if (binding.role === role && Array.isArray(binding.members)) {
                const next = binding.members.filter(m => m !== member);
                if (next.length !== binding.members.length) {
                    binding.members = next;
                    changed = true;
                }
            }
        }
        policy.bindings = (policy.bindings || []).filter(b => (b.members || []).length > 0);

        if (!changed) {
            console.log(`[TABLE-ACCESS] ${email} had no ${role} on ${tableId}`);
            return true;
        }
        await client.request({ url: `${base}:setIamPolicy`, method: 'POST', data: { policy } });
        console.log(`[TABLE-ACCESS] Revoked ${role} on ${tableId} from ${email}`);
        return true;
    } catch (error) {
        const detail = error.response?.data?.error?.message || error.message;
        console.error('[TABLE-ACCESS] Error revoking table access:', detail);
        throw new Error(`Failed to revoke table access: ${detail}`);
    }
};

/**
 * Grant an IAM role to a user on a specific project.
 * NOTE: This grants project-level access. For more granular access, use grantDatasetAccess.
 *
 * @param {string} projectId - The GCP Project ID.
 * @param {string} email - The email of the user or service account.
 * @param {string} role - The IAM role to grant (e.g., 'roles/bigquery.dataViewer').
 */
const grantIamAccess = async (projectId, email, role) => {
    console.log(`Granting IAM access: User=${email}, Role=${role}, Project=${projectId}`);

    try {
        // Use ADC
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });

        // Initialize Cloud Resource Manager API v1
        const cloudResourceManager = google.cloudresourcemanager({
            version: 'v1',
            auth: auth
        });

        // 1. Get current IAM Policy
        const getResponse = await cloudResourceManager.projects.getIamPolicy({
            resource: projectId,
            requestBody: {}
        });

        const policy = getResponse.data;
        let bindings = policy.bindings || [];
        const member = email.includes(':') ? email : `user:${email}`;

        // 2. Modify Policy
        let roleBinding = bindings.find(b => b.role === role);

        if (roleBinding) {
            // Check if member already exists
            if (!roleBinding.members.includes(member)) {
                roleBinding.members.push(member);
                console.log(`Added ${member} to existing binding for ${role}`);
            } else {
                console.log(`User ${member} already has role ${role}`);
                return true; // Already exists
            }
        } else {
            // Create new binding
            bindings.push({
                role: role,
                members: [member]
            });
            console.log(`Created new binding for ${role} with member ${member}`);
        }

        // 3. Set updated IAM Policy
        const setResponse = await cloudResourceManager.projects.setIamPolicy({
            resource: projectId,
            requestBody: {
                policy: {
                    bindings: bindings,
                    etag: policy.etag
                }
            }
        });

        console.log(`Successfully updated IAM policy for ${projectId}`);
        return true;

    } catch (error) {
        console.error('Error granting IAM access:', error);
        // Throwing error so calling service knows it failed
        throw new Error(`Failed to grant IAM access: ${error.message}`);
    }
};

/**
 * Revoke an IAM role from a user on a specific project.
 *
 * @param {string} projectId - The GCP Project ID.
 * @param {string} email - The email of the user or service account.
 * @param {string} role - The IAM role to revoke (e.g., 'roles/bigquery.dataViewer').
 */
const revokeIamAccess = async (projectId, email, role) => {
    console.log(`Revoking IAM access: User=${email}, Role=${role}, Project=${projectId}`);

    try {
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });

        const cloudResourceManager = google.cloudresourcemanager({
            version: 'v1',
            auth: auth
        });

        // 1. Get current IAM Policy
        const getResponse = await cloudResourceManager.projects.getIamPolicy({
            resource: projectId,
            requestBody: {}
        });

        const policy = getResponse.data;
        let bindings = policy.bindings || [];
        const member = email.includes(':') ? email : `user:${email}`;

        // 2. Find and modify the role binding
        const roleBindingIndex = bindings.findIndex(b => b.role === role);

        if (roleBindingIndex === -1) {
            console.log(`Role ${role} not found in project ${projectId}`);
            return true; // Role doesn't exist, nothing to revoke
        }

        const roleBinding = bindings[roleBindingIndex];
        const memberIndex = roleBinding.members.indexOf(member);

        if (memberIndex === -1) {
            console.log(`User ${member} doesn't have role ${role}`);
            return true; // User doesn't have this role, nothing to revoke
        }

        // Remove member from binding
        roleBinding.members.splice(memberIndex, 1);
        console.log(`Removed ${member} from role ${role}`);

        // If no members left in this binding, remove the entire binding
        if (roleBinding.members.length === 0) {
            bindings.splice(roleBindingIndex, 1);
            console.log(`Removed empty binding for role ${role}`);
        }

        // 3. Set updated IAM Policy
        const setResponse = await cloudResourceManager.projects.setIamPolicy({
            resource: projectId,
            requestBody: {
                policy: {
                    bindings: bindings,
                    etag: policy.etag
                }
            }
        });

        console.log(`Successfully revoked IAM access for ${email} on ${projectId}`);
        return true;

    } catch (error) {
        console.error('Error revoking IAM access:', error);
        throw new Error(`Failed to revoke IAM access: ${error.message}`);
    }
};

/**
 * Get all IAM bindings for a project
 *
 * @param {string} projectId - The GCP Project ID.
 * @returns {Object[]} List of IAM bindings
 */
const getIamBindings = async (projectId) => {
    const cached = iamBindingsCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.bindings;
    }

    console.log(`Fetching IAM bindings for project: ${projectId}`);

    try {
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });

        const cloudResourceManager = google.cloudresourcemanager({
            version: 'v1',
            auth: auth
        });

        const response = await cloudResourceManager.projects.getIamPolicy({
            resource: projectId,
            requestBody: {}
        });

        const bindings = response.data.bindings || [];
        iamBindingsCache.set(projectId, { bindings, expiresAt: Date.now() + IAM_BINDINGS_TTL_MS });
        return bindings;

    } catch (error) {
        console.error('Error fetching IAM bindings:', error);
        // Preserve the original error so callers can tell transient (429/5xx)
        // failures apart from a real permission denial.
        const wrapped = new Error(`Failed to fetch IAM bindings: ${error.message}`);
        wrapped.transient = isTransientError(error);
        wrapped.permissionDenied = isPermissionDenied(error);
        wrapped.cause = error;
        throw wrapped;
    }
};

/**
 * Check whether a user holds ANY of the given roles on a project, fetching the
 * project's IAM bindings only once (vs once per role). Returns a result object
 * instead of throwing for transient issues so callers can fail open.
 *
 * @param {string} projectId
 * @param {string} email
 * @param {string[]} roles - e.g. ['roles/owner', 'roles/viewer']
 * @returns {Promise<{hasAccess: boolean, degraded: boolean, matchedRole: string|null}>}
 *   degraded=true means the IAM policy could not be read due to a transient
 *   error and the answer is unknown (caller should fail open).
 */
const checkUserRoles = async (projectId, email, roles) => {
    const member = email.includes(':') ? email : `user:${email}`;
    try {
        const bindings = await getIamBindings(projectId);
        for (const role of roles) {
            const binding = bindings.find(b => b.role === role);
            if (binding && (binding.members || []).includes(member)) {
                return { hasAccess: true, degraded: false, matchedRole: role };
            }
        }
        return { hasAccess: false, degraded: false, matchedRole: null };
    } catch (error) {
        if (error.transient) {
            console.warn(`[IAM] Transient error reading IAM policy for ${projectId}; treating access as UNKNOWN (fail-open):`, error.message);
            return { hasAccess: false, degraded: true, matchedRole: null };
        }
        // Permission denied or other definitive errors => not granted via project IAM.
        console.warn(`[IAM] Could not verify project roles for ${projectId}:`, error.message);
        return { hasAccess: false, degraded: false, matchedRole: null };
    }
};

/**
 * Verify if a user has a specific IAM role on a project
 *
 * @param {string} projectId - The GCP Project ID.
 * @param {string} email - The email of the user.
 * @param {string} role - The IAM role to check.
 * @returns {boolean} True if user has the role
 */
const verifyUserAccess = async (projectId, email, role) => {
    try {
        const bindings = await getIamBindings(projectId);
        const member = email.includes(':') ? email : `user:${email}`;

        const roleBinding = bindings.find(b => b.role === role);
        if (!roleBinding) return false;

        return roleBinding.members.includes(member);

    } catch (error) {
        console.error('Error verifying user access:', error);
        return false;
    }
};

/**
 * List all members for a specific project (grouped by role)
 *
 * @param {string} projectId - The GCP Project ID.
 * @returns {Object[]} List of members with their roles
 */
const listProjectMembers = async (projectId) => {
    try {
        const bindings = await getIamBindings(projectId);

        // Create a map of members to roles
        const memberRoles = new Map();

        for (const binding of bindings) {
            for (const member of binding.members) {
                if (!memberRoles.has(member)) {
                    memberRoles.set(member, []);
                }
                memberRoles.get(member).push(binding.role);
            }
        }

        // Convert to array format
        const result = [];
        for (const [member, roles] of memberRoles.entries()) {
            // Extract email from member string (e.g., "user:email@example.com" -> "email@example.com")
            const email = member.includes(':') ? member.split(':')[1] : member;
            const type = member.includes(':') ? member.split(':')[0] : 'user';

            result.push({
                member,
                email,
                type,
                roles
            });
        }

        return result;

    } catch (error) {
        console.error('Error listing project members:', error);
        throw new Error(`Failed to list project members: ${error.message}`);
    }
};

module.exports = {
    // Dataset-level access (recommended - more granular)
    grantDatasetAccess,
    revokeDatasetAccess,
    // Table-level access (most granular — only the requested table)
    grantTableAccess,
    revokeTableAccess,
    // Project-level IAM (grants access to all datasets in project)
    grantIamAccess,
    revokeIamAccess,
    getIamBindings,
    verifyUserAccess,
    checkUserRoles,
    listProjectMembers
};
