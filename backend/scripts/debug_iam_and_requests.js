
const { Firestore } = require('@google-cloud/firestore');
const { BigQuery } = require('@google-cloud/bigquery');
require('dotenv').config({ path: '../backend/.env' });

async function debugIAM() {
    console.log('--- STARTING DEBUG ---');
    console.log('Project ID:', process.env.GOOGLE_CLOUD_PROJECT_ID);

    const firestore = new Firestore({
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    });

    const requestsRef = firestore.collection('access-requests');
    const snapshot = await requestsRef.get();

    if (snapshot.empty) {
        console.log('No APPROVED requests found.');
        return;
    }

    console.log(`Found ${snapshot.size} APPROVED requests.`);

    for (const doc of snapshot.docs) {
        const data = doc.data();
        console.log(`\n--- Request ID: ${doc.id} ---`);
        console.log('Status:', data.status);
        console.log('Requester:', data.requesterEmail);
        console.log('Linked Resource:', data.linkedResource);
        console.log('Asset Name:', data.assetName);

        // Test Regex Logic
        const linkedResource = data.linkedResource || data.assetName || '';
        let iamProjectId, datasetId;

        const bqMatch = linkedResource.match(/projects\/([^/]+)\/datasets\/([^/]+)/);
        if (bqMatch && bqMatch.length >= 3) {
            iamProjectId = bqMatch[1];
            datasetId = bqMatch[2];
            console.log(`[MATCH] Standard Regex: Project=${iamProjectId}, Dataset=${datasetId}`);
        } else if (linkedResource.includes('bigquery:') || linkedResource.includes('bigquery://')) {
            const fqn = linkedResource.replace('bigquery://', '').replace('bigquery:', '');
            const parts = fqn.split('.');
            if (parts.length >= 2) {
                iamProjectId = parts[0];
                datasetId = parts[1];
                console.log(`[MATCH] Custom Parser: Project=${iamProjectId}, Dataset=${datasetId}`);
            } else {
                console.log('[FAIL] Custom Parser found < 2 parts:', parts);
            }
        } else {
            console.log('[FAIL] No regex matched linkedResource.');
        }

        if (iamProjectId && datasetId) {
            // Check ACTUAL IAM
            try {
                const bigquery = new BigQuery({ projectId: iamProjectId });
                const dataset = bigquery.dataset(datasetId);
                const [metadata] = await dataset.getMetadata();
                const access = metadata.access || [];
                const userAccess = access.find(a => a.userByEmail === data.requesterEmail);

                if (userAccess) {
                    console.log(`[IAM CHECK] User Has Access: ROLE=${userAccess.role}`);
                } else {
                    console.log(`[IAM CHECK] User NOT FOUND in dataset ACL.`);
                }
            } catch (err) {
                console.log(`[IAM CHECK] Failed to fetch dataset metadata: ${err.message}`);
            }
        }
    }
}

debugIAM().catch(console.error);
