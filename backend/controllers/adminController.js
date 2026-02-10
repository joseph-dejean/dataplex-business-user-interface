const { BigQuery } = require('@google-cloud/bigquery');
const { updateAccessRequestStatus } = require('../services/accessRequestService');

// Initialize BigQuery client
const bigquery = new BigQuery();

/**
 * Helper: Grant READER access to a dataset
 */
const grantDatasetAccess = async (projectId, datasetId, userEmail) => {
    try {
        console.log(`[IAM-AUTO] Attempting to grant access. Project: ${projectId}, Dataset: ${datasetId}, User: ${userEmail}`);

        // Reference the dataset
        // Note: If the dataset is in another project, we might need to specify projectId in bigquery constructor or dataset options
        // For now, assuming standard reference pattern
        const dataset = bigquery.dataset(datasetId, { projectId });

        // Fetch current metadata
        const [metadata] = await dataset.getMetadata();

        // Check if user already exists
        const accessList = metadata.access || [];
        const userExists = accessList.some(entry => entry.userByEmail === userEmail);

        if (userExists) {
            console.log(`[IAM-AUTO] User ${userEmail} already has access to ${datasetId}. Skipping update.`);
            return;
        }

        // Add new reader
        accessList.push({
            role: 'READER',
            userByEmail: userEmail
        });

        // Update the dataset
        await dataset.setMetadata({ access: accessList });
        console.log(`[IAM-AUTO] Granted READER access to ${userEmail} on ${datasetId}`);

    } catch (error) {
        console.error(`[IAM-AUTO] FAILED to grant access:`, error);
        throw error; // Propagate error to stop Firestore update
    }
};

/**
 * Handle Access Request Approval/Rejection
 * Expects: { requestId, status, userEmail, linkedResource }
 */
const handleAccessRequest = async (req, res) => {
    try {
        const { requestId, status, userEmail, linkedResource, adminNote } = req.body;

        if (!requestId || !status || !userEmail) {
            return res.status(400).json({ error: 'Missing required fields: requestId, status, userEmail' });
        }

        console.log(`[ADMIN-CTRL] Processing Access Request: ${requestId}, Status: ${status}`);

        // LOGIC: If APPROVED, attempt IAM update first
        if (status === 'APPROVED') {
            if (!linkedResource) {
                return res.status(400).json({ error: 'Cannot approve request without linkedResource (asset name).' });
            }

            // Parse linkedResource
            // Format example: //bigquery.googleapis.com/projects/my-project/datasets/my_dataset/tables/my_table
            // Or: projects/my-project/datasets/my_dataset

            let projectId, datasetId;

            // Regex to extract project and dataset
            // Matches "projects/{project}/datasets/{dataset}" pattern which exists in both formats
            const match = linkedResource.match(/projects\/([^/]+)\/datasets\/([^/]+)/);

            if (match && match.length >= 3) {
                projectId = match[1];
                datasetId = match[2];
            } else {
                console.error('[ADMIN-CTRL] Invalid linkedResource format:', linkedResource);
                return res.status(400).json({ error: 'Invalid resource format. Expected ...projects/{p}/datasets/{d}...' });
            }

            // Perform IAM Update
            await grantDatasetAccess(projectId, datasetId, userEmail);
        }

        // If IAM success (or if REJECTED), update Firestore
        // We use the service function updateAccessRequestStatus
        const updatedRequest = await updateAccessRequestStatus(requestId, status, req.user?.email || 'admin@system', adminNote);

        return res.json({
            success: true,
            message: `Request ${status}`,
            data: updatedRequest
        });

    } catch (error) {
        console.error('[ADMIN-CTRL] Error handling access request:', error);
        return res.status(500).json({
            error: 'Failed to process request',
            details: error.message
        });
    }
};

module.exports = {
    handleAccessRequest
};
