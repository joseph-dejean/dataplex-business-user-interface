// server.js
require('dotenv').config(); // Load .env file
console.log('[STARTUP] Starting server initialization...');
console.log('[STARTUP] Loading core modules...');
const { VertexAI } = require('@google-cloud/vertexai');
const express = require('express');
const fs = require('fs').promises;
const { GoogleAuth, OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
console.log('[STARTUP] Loading Google Cloud clients...');
const { CatalogServiceClient, DataScanServiceClient, protos, DataplexServiceClient } = require('@google-cloud/dataplex');
const { ProjectsClient } = require('@google-cloud/resource-manager');
const { LineageClient } = require('@google-cloud/lineage');
const { DataCatalogClient } = require('@google-cloud/datacatalog');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
console.log('[STARTUP] Loading custom modules...');
const authMiddleware = require('./middlewares/authMiddleware');
const { querySampleFromBigQuery } = require('./utility');
const { sendAccessRequestEmail, sendApprovalEmail, sendRejectionEmail, sendFeedbackEmail } = require('./services/emailService');
const { createAccessRequest, getAccessRequests, updateAccessRequestStatus, getAccessRequestById } = require('./services/accessRequestService');
const { grantIamAccess, revokeIamAccess, getIamBindings, verifyUserAccess } = require('./services/gcpIamService');
const adminService = require('./services/adminService');
const grantedAccessService = require('./services/grantedAccessService');
const notificationService = require('./services/notificationService');
const datasetRelationshipService = require('./services/datasetRelationshipService');
const { BigQuery } = require('@google-cloud/bigquery');
console.log('[STARTUP] All modules loaded successfully');

// --- PROJECT ID RESOLUTION ---
// Resolves the GCP project ID from multiple environment variable sources.
// Cloud Run sets GOOGLE_CLOUD_PROJECT automatically. Other envs may use different names.
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID
  || process.env.GOOGLE_CLOUD_PROJECT
  || process.env.GCP_PROJECT
  || process.env.GCLOUD_PROJECT
  || '';

if (!PROJECT_ID) {
  console.error('[STARTUP] CRITICAL: No GCP Project ID found in environment variables!');
  console.error('[STARTUP] Checked: GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_PROJECT, GCP_PROJECT, GCLOUD_PROJECT');
  console.error('[STARTUP] Some endpoints will fail. Set one of these env vars.');
} else {
  console.log(`[STARTUP] Project ID resolved: ${PROJECT_ID}`);
}

// Helper function for consistent project ID access throughout the codebase
const getProjectId = () => PROJECT_ID;

// Use GoogleAuth for ADC
class AdcGoogleAuth extends GoogleAuth {
  constructor() {
    super({
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
  }

  async getClient() {
    return super.getClient();
  }
}


const app = express();
app.set('etag', false);

app.use(cors());
// Middleware to parse JSON request bodies
app.use(express.json());

// Disable HTTP caching for API routes to prevent stale 304 responses
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// Mount Admin Routes (IAM Automation)
const adminRoutes = require('./routes/adminRoutes');
app.use('/api/v1/admin', adminRoutes);

const { getOrCreateDataAgent } = require('./services/dataAgentService');
// --- END DATA AGENT MANAGEMENT ---

// --- START CONVERSATIONAL ANALYTICS CODE ---
// Using Google Cloud Conversational Analytics API (geminidataanalytics.googleapis.com)

/**
 * POST /api/v1/chat
 * Chat with a table using Google Cloud Conversational Analytics API
 * 
 * Request Body:
 * {
 *   "message": "User's question in natural language",
 *   "context": {
 *     "fullyQualifiedName": "bigquery://project.dataset.table",
 *     "name": "Table name",
 *     "description": "Table description",
 *     "schema": [...],
 *     "entryType": "TABLE",
 *     "conversationHistory": [] // Optional: for multi-turn conversations
 *   }
 * }
 */
app.post('/api/v1/chat', async (req, res) => {
  const { message, context } = req.body;
  try {
    // Extract user's access token - this ensures queries run with USER's permissions
    const userAccessToken = req.headers.authorization?.split(' ')[1];

    if (!userAccessToken) {
      return res.status(401).json({ error: 'Authorization token is required.' });
    }

    if (!message || !context) {
      return res.status(400).json({ error: 'Message and context are required.' });
    }

    // Debug Frontend Schema
    if (context.schema) {
      console.log('DEBUG_SCHEMA_PAYLOAD:', JSON.stringify(context.schema.slice(0, 3), null, 2)); // Log first 3 fields
    } else {
      console.log('DEBUG_SCHEMA_PAYLOAD: MISSING');
    }

    // Extract BigQuery table reference from fullyQualifiedName
    // Format: bigquery://project.dataset.table or project:dataset.table
    let projectId, datasetId, tableId;

    if (context.fullyQualifiedName) {
      let fqn = context.fullyQualifiedName;

      // Handle "bigquery:" prefix (common in Dataplex FQNs)
      if (fqn.startsWith('bigquery:')) {
        fqn = fqn.substring(9); // Remove "bigquery:"
        // Example now: dataplex-ui.coffee_shop.order_item
      } else if (fqn.startsWith('bigquery://')) {
        fqn = fqn.replace('bigquery://', '');
      }

      const parts = fqn.split('.');
      if (parts.length >= 3) {
        projectId = parts[0];
        datasetId = parts[1];
        tableId = parts[2];
      } else if (fqn.includes(':') && !fqn.startsWith('bigquery:')) {
        // Handle older format project:dataset.table if still used, but unlikely with new cleaning
        const [project, rest] = fqn.split(':');
        projectId = project;
        const restParts = rest.split('.');
        if (restParts.length >= 2) {
          datasetId = restParts[0];
          tableId = restParts[1];
        }
      }
    }

    // Check if this is a Data Product
    const isDataProduct = context.isDataProduct === true;

    // If we can't extract BigQuery reference, fall back to metadata-only mode
    if (!projectId || !datasetId || !tableId) {
      // Fallback: Use Vertex AI for non-BigQuery tables or when FQN is not available
      // Vertex AI requires a specific region (not multi-region like 'us'), default to us-central1
      const vertexLocation = (process.env.GCP_LOCATION && process.env.GCP_LOCATION.includes('-')) ? process.env.GCP_LOCATION : 'us-central1';
      const vertex_ai = new VertexAI({
        project: PROJECT_ID,
        location: vertexLocation
      });
      const generativeModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

      let prompt = '';

      if (isDataProduct && context.tables && context.tables.length > 0) {
        // For Data Products, include information about all tables
        prompt = `
          You are a helpful Data Steward assistant for Dataplex.
          
          The user is asking about a Data Product: ${context.name}
          Description: ${context.description}
          
          This Data Product contains the following tables:
          ${context.tables.map((table, idx) => `
            ${idx + 1}. ${table.name} (${table.type})
               - Fully Qualified Name: ${table.fullyQualifiedName}
               - Description: ${table.description || 'No description'}
          `).join('\n')}
          
          User Question: ${message}
          
          Answer the user's question about this Data Product and its tables. Keep it concise.
        `;
      } else {
        // For regular tables
        prompt = `
          You are a helpful Data Steward assistant for Dataplex.
          
          Here is the metadata for the dataset the user is looking at:
          Name: ${context.name}
          Description: ${context.description}
          Schema/Columns: ${JSON.stringify(context.schema || [])}
          
          User Question: ${message}
          
          Answer the user's question based strictly on the metadata provided above. Keep it concise.
        `;
      }

      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const text = response.candidates[0].content.parts[0].text;

      return res.json({ reply: text });
    }

    // Use Conversational Analytics API with inline context for BigQuery tables
    const projectId_env = PROJECT_ID;
    // CA API requires a specific region (not multi-region like 'us' or 'eu'), default to us-central1
    const rawLocation = process.env.GCP_LOCATION || 'us-central1';
    const location = rawLocation.includes('-') ? rawLocation : 'us-central1';

    if (!projectId_env) {
      console.error('[CHAT] CRITICAL: No project ID found in environment variables!');
      return res.status(200).json({
        reply: "Configuration error: The server is not properly configured with a Google Cloud Project ID. Please contact your administrator.",
        error: true
      });
    }

    const chatUrl = `https://geminidataanalytics.googleapis.com/v1beta/projects/${projectId_env}/locations/${location}:chat`;

    // Build BigQuery data source reference
    // For Data Products, include all tables; for single tables, include just that table
    let tableReferences = [];

    if (isDataProduct && context.tables && context.tables.length > 0) {
      // For Data Products or multi-table chat, extract BigQuery references from all tables
      console.log('Processing multi-table context with', context.tables.length, 'tables');

      context.tables.forEach((table, idx) => {
        let fqn = table.fullyQualifiedName || '';
        console.log(`Table ${idx}: ${table.name}, FQN: ${fqn}`);

        let tProjectId, tDatasetId, tTableId;

        // Handle various FQN formats
        if (fqn.startsWith('bigquery://')) {
          // Format: bigquery://project.dataset.table
          const parts = fqn.replace('bigquery://', '').split('.');
          if (parts.length >= 3) {
            tProjectId = parts[0];
            tDatasetId = parts[1];
            tTableId = parts[2];
          }
        } else if (fqn.startsWith('bigquery:')) {
          // Format: bigquery:project.dataset.table (Dataplex FQN format)
          const parts = fqn.replace('bigquery:', '').split('.');
          if (parts.length >= 3) {
            tProjectId = parts[0];
            tDatasetId = parts[1];
            tTableId = parts[2];
          }
        } else if (fqn.includes(':') && fqn.includes('.')) {
          // Format: project:dataset.table
          const [project, rest] = fqn.split(':');
          tProjectId = project;
          const parts = rest.split('.');
          if (parts.length >= 2) {
            tDatasetId = parts[0];
            tTableId = parts[1];
          }
        } else if (fqn.includes('.')) {
          // Format: project.dataset.table (simple dot notation)
          const parts = fqn.split('.');
          if (parts.length >= 3) {
            tProjectId = parts[0];
            tDatasetId = parts[1];
            tTableId = parts[2];
          }
        }

        if (tProjectId && tDatasetId && tTableId) {
          console.log(`Parsed table reference: ${tProjectId}.${tDatasetId}.${tTableId}`);
          tableReferences.push({
            projectId: tProjectId,
            datasetId: tDatasetId,
            tableId: tTableId
            // Let the CA API resolve schema from BigQuery directly
          });
        } else {
          console.warn(`Could not parse FQN for table: ${table.name}, FQN: ${fqn}`);
        }
      });
    } else {
      // Single table
      console.log(`DEBUG_EXTRACTED_REF: Project=${projectId}, Dataset=${datasetId}, Table=${tableId}, FQN=${context.fullyQualifiedName}`);

      tableReferences = [{
        projectId: projectId,
        datasetId: datasetId,
        tableId: tableId
        // Removed manual schema/fields injection to let the API resolve it from BigQuery
      }];
    }

    console.log('DEBUG_TABLE_REFS_PAYLOAD:', JSON.stringify(tableReferences, null, 2));

    // If no valid table references found, fall back to Vertex AI
    if (tableReferences.length === 0) {
      const vertex_ai = new VertexAI({
        project: PROJECT_ID,
        location: process.env.GCP_LOCATION || 'us-central1'
      });
      const generativeModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const prompt = isDataProduct
        ? `You are a helpful Data Steward assistant for Dataplex. The user is asking about Data Product: ${context.name}. ${context.description}. User Question: ${message}`
        : `You are a helpful Data Steward assistant for Dataplex. Name: ${context.name}. Description: ${context.description}. Schema: ${JSON.stringify(context.schema || [])}. User Question: ${message}`;

      const result = await generativeModel.generateContent(prompt);
      const response = result.response;
      const text = response.candidates[0].content.parts[0].text;
      return res.json({ reply: text });
    }

    const bigqueryDataSource = {
      bq: {
        tableReferences: tableReferences
      }
    };

    // For the FIRST message, we send the full context with inline data sources
    // For SUBSEQUENT messages, we use conversation_reference to let Google manage state
    const messages = [{
      userMessage: {
        text: message
      }
    }];

    const systemInstruction = 'You are a helpful Data Steward assistant for Dataplex. Answer questions about the data tables based on their schema and metadata. Be concise and accurate.';

    // Use ADC (service account) token for CA API - the user's OAuth token lacks the cloud-platform scope
    // needed by geminidataanalytics.googleapis.com. The service account has the proper IAM roles.
    const adcAuth = new AdcGoogleAuth();
    const adcClient = await adcAuth.getClient();
    const adcToken = (await adcClient.getAccessToken()).token;
    const adcEmail = adcClient.email || 'unknown';
    console.log(`Using ADC service account token for CA API call (SA: ${adcEmail}, location: ${location})`);

    let chatPayload;
    const existingConversationId = context.conversationId; // From frontend state

    // Try to create/get a persistent Data Agent for better performance and caching
    let dataAgentName = null;
    try {
      dataAgentName = await getOrCreateDataAgent(tableReferences, systemInstruction, {
        projectId: projectId_env,
        location: location,
        accessToken: adcToken
      });
      if (dataAgentName) {
        console.log(`[DataAgent] Using persistent agent: ${dataAgentName}`);
      }
    } catch (agentErr) {
      console.warn(`[DataAgent] Error during agent creation, falling back to inline context: ${agentErr.message}`);
    }

    if (existingConversationId) {
      // --- STATEFUL MODE: Resume existing conversation ---
      // Google stores the history, we just send the new message
      console.log(`[Stateful] Resuming conversation: ${existingConversationId}`);
      if (dataAgentName) {
        chatPayload = {
          parent: `projects/${projectId_env}/locations/${location}`,
          messages: messages,
          conversationReference: {
            conversation: `projects/${projectId_env}/locations/${location}/conversations/${existingConversationId}`,
            dataAgentContext: {
              dataAgent: dataAgentName
            }
          }
        };
      } else {
        chatPayload = {
          parent: `projects/${projectId_env}/locations/${location}`,
          messages: messages,
          conversationReference: {
            conversation: `projects/${projectId_env}/locations/${location}/conversations/${existingConversationId}`,
            inlineContext: {
              datasourceReferences: bigqueryDataSource,
              systemInstruction: systemInstruction
            }
          }
        };
      }
    } else {
      // --- FIRST MESSAGE: Create new conversation ---
      if (dataAgentName) {
        console.log('[Stateful] Starting new conversation with persistent Data Agent');
        chatPayload = {
          parent: `projects/${projectId_env}/locations/${location}`,
          messages: messages,
          dataAgentContext: {
            dataAgent: dataAgentName
          }
        };
      } else {
        console.log('[Stateful] Starting new conversation with inline context (no agent available)');
        chatPayload = {
          parent: `projects/${projectId_env}/locations/${location}`,
          messages: messages,
          inlineContext: {
            datasourceReferences: bigqueryDataSource,
            systemInstruction: systemInstruction
          }
        };
      }
    }

    // Make request to Conversational Analytics API using ADC service account token
    const chatResponse = await axios.post(chatUrl, chatPayload, {
      headers: {
        'Authorization': `Bearer ${adcToken}`,
        'Content-Type': 'application/json',
        'x-server-timeout': '300'
      },
      responseType: 'arraybuffer' // Fetch raw bytes to avoid stream encoding issues
    });

    let fullResponseText = '';
    let finalChart = null;
    let finalSql = null;
    let rawDataRows = [];
    let returnedConversationId = existingConversationId || null; // Will be updated from response
    let accumulatedJson = chatResponse.data.toString('utf-8'); // Convert buffer to string properly

    console.log('DEBUG_RAW_RESPONSE_LENGTH:', accumulatedJson.length);
    console.log('DEBUG_FULL_RAW_RESPONSE:', accumulatedJson); // Log EVERYTHING to find hidden data

    // Parse the full accumulated JSON
    try {
      let cleanBuffer = accumulatedJson.trim();
      // Ensure it's a valid list if it does not start with [
      if (cleanBuffer && !cleanBuffer.startsWith('[')) {
        // It might be multiple JSON objects concatenated or separated by newlines
        // Regex to join } { into },{
        cleanBuffer = `[${cleanBuffer.replace(/\}\s*\{/g, '},{')}]`;
      }

      // Handle trailing commas
      if (cleanBuffer.endsWith(',]')) cleanBuffer = cleanBuffer.slice(0, -2) + ']';

      const parsedMessages = JSON.parse(cleanBuffer);

      if (Array.isArray(parsedMessages)) {
        parsedMessages.forEach((msg, index) => {
          // Log ALL top-level keys for every message so we can see the full structure
          console.log(`DEBUG_MSG_${index}_TOP_KEYS:`, Object.keys(msg));

          // Extract conversation ID - check multiple possible locations
          const convName = msg.metadata?.conversationName || msg.conversationName
            || msg.metadata?.conversation || msg.conversation
            || msg.systemMessage?.conversationName || msg.systemMessage?.metadata?.conversationName;
          if (convName && !returnedConversationId) {
            // Format: projects/{project}/locations/{location}/conversations/{id}
            const convParts = convName.split('/');
            if (convParts.length >= 6) {
              returnedConversationId = convParts[convParts.length - 1];
              console.log(`[Stateful] Extracted conversation ID from conversationName: ${returnedConversationId}`);
            } else {
              // Maybe it's just the raw ID
              returnedConversationId = convName;
              console.log(`[Stateful] Extracted raw conversation ID: ${returnedConversationId}`);
            }
          }
          // Also check for conversationId directly
          if (msg.conversationId && !returnedConversationId) {
            returnedConversationId = msg.conversationId;
            console.log(`[Stateful] Extracted conversationId directly: ${returnedConversationId}`);
          }

          if (msg.systemMessage) {
            console.log(`DEBUG_MSG_${index}_KEYS:`, Object.keys(msg.systemMessage)); // Log what keys exist (e.g. text, chart, data?)

            // 1. Text
            if (msg.systemMessage.text) {
              const t = msg.systemMessage.text;
              if (t.textType === 'FINAL_RESPONSE') {
                // Handle multiple response formats from API:
                // - t.text (string)
                // - t.content (string)
                // - t.parts (array of strings)
                if (t.text) {
                  fullResponseText += t.text;
                } else if (t.content) {
                  fullResponseText += t.content;
                } else if (t.parts && Array.isArray(t.parts)) {
                  // Parts can be strings or objects with text property
                  t.parts.forEach(part => {
                    if (typeof part === 'string') {
                      fullResponseText += part;
                    } else if (part?.text) {
                      fullResponseText += part.text;
                    }
                  });
                }
              } else if (t.textType === 'THOUGHT' && t.parts && t.parts[0]) {
                // Thought messages - extract text from parts
                const thoughtText = typeof t.parts[0] === 'string' ? t.parts[0] : t.parts[0]?.text;
                if (thoughtText) {
                  fullResponseText += `\n*Thought: ${thoughtText}*\n`;
                }
              }
            }
            // 2. Chart
            if (msg.systemMessage.chart) {
              const rawChart = msg.systemMessage.chart;
              console.log('DEBUG_CHART_FULL_STRUCTURE:', JSON.stringify(rawChart, null, 2));
              console.log('DEBUG_CHART_KEYS:', Object.keys(rawChart));

              // The Google API returns chart data in various formats.
              // We need to find the Vega-Lite spec OR build one from raw data.

              let vegaSpec = null;

              // First, check if there's a result wrapper (Google's format)
              const chartData = rawChart.result || rawChart;
              console.log('DEBUG_CHART_DATA_KEYS:', Object.keys(chartData));

              // Check various locations for the Vega-Lite spec
              if (chartData.$schema || chartData.mark || chartData.layer) {
                // It's already a valid Vega-Lite spec
                vegaSpec = chartData;
              } else if (chartData.vegaLiteSpec) {
                vegaSpec = chartData.vegaLiteSpec;
              } else if (chartData.spec) {
                vegaSpec = chartData.spec;
              } else if (chartData.vegaLite) {
                vegaSpec = chartData.vegaLite;
              } else if (chartData.chartSpec) {
                vegaSpec = chartData.chartSpec;
              } else if (chartData.visualization?.spec) {
                vegaSpec = chartData.visualization.spec;
              } else if (chartData.visualization?.vegaLiteSpec) {
                vegaSpec = chartData.visualization.vegaLiteSpec;
              } else if (chartData.data && chartData.encoding) {
                // It has Vega-Lite-like properties, use as-is
                vegaSpec = chartData;
              } else if (chartData.data && Array.isArray(chartData.data) && chartData.chartType) {
                // Google returns raw data with chartType - build a Vega-Lite spec
                console.log('DEBUG_BUILDING_VEGA_FROM_GOOGLE_DATA:', chartData.chartType);
                const dataRows = chartData.data;
                if (dataRows.length > 0) {
                  const columns = Object.keys(dataRows[0]);
                  // Assume first column is category (x), second is value (y)
                  const xField = columns[0];
                  const yField = columns.length > 1 ? columns[1] : columns[0];

                  // Determine mark type from Google's chartType
                  let markType = 'bar';
                  if (chartData.chartType.toLowerCase().includes('line')) markType = 'line';
                  else if (chartData.chartType.toLowerCase().includes('pie')) markType = 'arc';
                  else if (chartData.chartType.toLowerCase().includes('scatter')) markType = 'point';
                  else if (chartData.chartType.toLowerCase().includes('area')) markType = 'area';

                  vegaSpec = {
                    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
                    "data": { "values": dataRows },
                    "mark": markType,
                    "encoding": {
                      "x": { "field": xField, "type": "nominal", "title": xField },
                      "y": { "field": yField, "type": "quantitative", "title": yField }
                    },
                    "width": 400,
                    "height": 300
                  };

                  // For pie charts, adjust encoding
                  if (markType === 'arc') {
                    vegaSpec.encoding = {
                      "theta": { "field": yField, "type": "quantitative" },
                      "color": { "field": xField, "type": "nominal" }
                    };
                  }

                  console.log('DEBUG_BUILT_VEGA_SPEC:', JSON.stringify(vegaSpec, null, 2).substring(0, 300));
                }
              }

              if (vegaSpec) {
                console.log('DEBUG_VEGA_SPEC_FOUND:', JSON.stringify(vegaSpec, null, 2).substring(0, 300));
                finalChart = vegaSpec;
              } else {
                // Could not find or build a Vega-Lite spec
                console.log('DEBUG_CHART_UNKNOWN_FORMAT - Cannot render, chartData keys:', Object.keys(chartData));
                console.log('DEBUG_CHART_DATA_SAMPLE:', JSON.stringify(chartData, null, 2).substring(0, 500));
              }
            }

            // 3. Data, SQL, Chart from result objects
            // Check msg.systemMessage.data.result OR msg.systemMessage.schema.result
            const dataResult = msg.systemMessage.data?.result || msg.systemMessage.schema?.result;

            if (dataResult) {
              console.log(`DEBUG_MSG_${index}_DATA_RESULT_KEYS:`, Object.keys(dataResult));

              // 3a. Extract SQL from inside the data result
              if (!finalSql && (dataResult.sql || dataResult.sqlQuery || dataResult.query)) {
                finalSql = dataResult.sql || dataResult.sqlQuery || dataResult.query;
                console.log(`DEBUG_MSG_${index}_SQL_FOUND_IN_RESULT:`, finalSql.substring(0, 200));
              }

              // 3b. Extract chart/visualization from inside the data result
              if (!finalChart) {
                const resultChart = dataResult.chart || dataResult.visualization || dataResult.vegaLiteSpec || dataResult.vegaSpec;
                if (resultChart) {
                  console.log(`DEBUG_MSG_${index}_CHART_FOUND_IN_RESULT_KEYS:`, Object.keys(resultChart));
                  // Try to extract Vega-Lite spec from the chart object
                  let vegaFromResult = null;
                  if (resultChart.$schema || resultChart.mark || resultChart.layer) {
                    vegaFromResult = resultChart;
                  } else if (resultChart.vegaLiteSpec) {
                    vegaFromResult = resultChart.vegaLiteSpec;
                  } else if (resultChart.spec) {
                    vegaFromResult = resultChart.spec;
                  } else if (resultChart.chartSpec) {
                    vegaFromResult = resultChart.chartSpec;
                  } else if (resultChart.data && resultChart.encoding) {
                    vegaFromResult = resultChart;
                  } else if (typeof resultChart === 'string') {
                    // Maybe it's a JSON string
                    try { vegaFromResult = JSON.parse(resultChart); } catch (e) { /* not JSON */ }
                  } else {
                    // Use it as-is and let the frontend try
                    vegaFromResult = resultChart;
                    console.log(`DEBUG_MSG_${index}_CHART_RAW_FROM_RESULT:`, JSON.stringify(resultChart).substring(0, 500));
                  }
                  if (vegaFromResult) {
                    finalChart = vegaFromResult;
                    console.log(`DEBUG_MSG_${index}_CHART_EXTRACTED_FROM_RESULT`);
                  }
                }
              }

              // 3c. Format Data as Markdown Table
              if (dataResult.data && Array.isArray(dataResult.data) && dataResult.data.length > 0) {
                const rows = dataResult.data;
                const columns = Object.keys(rows[0]);
                const displayLimit = 10;

                // Clean up floating point precision issues (e.g. "75265.87999999999" → "75265.88")
                const cleanValue = (val) => {
                  if (typeof val === 'string' && /^-?\d+\.\d{3,}$/.test(val)) {
                    return parseFloat(parseFloat(val).toFixed(2)).toString();
                  }
                  if (typeof val === 'number' && !Number.isInteger(val)) {
                    return parseFloat(val.toFixed(2)).toString();
                  }
                  return val;
                };
                const cleanedRows = rows.map(row => {
                  const cleaned = {};
                  for (const key of Object.keys(row)) {
                    cleaned[key] = cleanValue(row[key]);
                  }
                  return cleaned;
                });

                // Keep cleaned data rows for synthesis and frontend
                rawDataRows = cleanedRows;

                // Header
                let tableMd = `\n\n**Data Results:**\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n`;

                // Rows
                cleanedRows.slice(0, displayLimit).forEach(row => {
                  const vals = columns.map(c => row[c]);
                  tableMd += `| ${vals.join(' | ')} |\n`;
                });

                if (rows.length > displayLimit) {
                  tableMd += `\n*(Showing top ${displayLimit} of ${rows.length} rows)*\n`;
                }

                fullResponseText += tableMd;
              }
            }

            // 4. SQL (also check at systemMessage level)
            if (!finalSql && msg.systemMessage.sqlQuery) {
              finalSql = msg.systemMessage.sqlQuery;
            }
            if (!finalSql && msg.systemMessage.sql) {
              finalSql = msg.systemMessage.sql;
            }
          }

          // Handle direct response format (CA API sometimes returns fields at top level)
          if (msg.reply && !msg.systemMessage) {
            fullResponseText += msg.reply;
          }
          if (msg.chart && !msg.systemMessage) {
            finalChart = msg.chart;
          }
          if ((msg.sql || msg.sqlQuery) && !msg.systemMessage) {
            finalSql = msg.sql || msg.sqlQuery;
          }
          if (msg.data && Array.isArray(msg.data) && msg.data.length > 0 && !msg.systemMessage) {
            rawDataRows = msg.data;
          }
          if (msg.conversationId) {
            returnedConversationId = msg.conversationId;
          }

          if (msg.error) {
            console.error('API Returned Error:', msg.error);
            fullResponseText += `\nError: ${msg.error.message}`;
          }
        });

        // After processing all messages, if we still don't have conversationId/sql/chart,
        // do a deep search on the raw parsed data
        if (!returnedConversationId) {
          // Search entire response for conversation name pattern
          const convMatch = accumulatedJson.match(/"conversationName"\s*:\s*"([^"]+)"/);
          if (convMatch) {
            const parts = convMatch[1].split('/');
            returnedConversationId = parts.length >= 6 ? parts[parts.length - 1] : convMatch[1];
            console.log(`[Stateful] Fallback extracted conversation ID from raw: ${returnedConversationId}`);
          }
        }
        if (!finalSql) {
          // Search for SQL in raw response
          const sqlMatch = accumulatedJson.match(/"(?:sql|sqlQuery|query)"\s*:\s*"(SELECT[^"]+)"/i);
          if (sqlMatch) {
            finalSql = sqlMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            console.log(`[Fallback] Extracted SQL from raw response: ${finalSql.substring(0, 100)}`);
          }
        }
      }
    } catch (e) {
      console.error('JSON Parse Error of Stream:', e);
      console.log('Raw Buffer:', accumulatedJson);
      // Fallback: simple text extraction
      const matches = accumulatedJson.match(/"text":\s*"([^"]+)"/g);
      if (matches) {
        fullResponseText = matches.map(m => m.split(':')[1].replace(/"/g, '').trim()).join(' ');
      } else {
        fullResponseText = "Received response but failed to parse. Check server logs.";
      }
    }

    // Auto-generate chart from data if API didn't return one
    if (!finalChart && rawDataRows && rawDataRows.length > 0) {
      try {
        const columns = Object.keys(rawDataRows[0]);
        // Find a numeric column for Y axis and a text/id column for X axis
        const numericCol = columns.find(c => {
          const val = rawDataRows[0][c];
          return !isNaN(parseFloat(val)) && columns.indexOf(c) > 0; // prefer non-first column
        }) || columns.find(c => !isNaN(parseFloat(rawDataRows[0][c])));
        const labelCol = columns.find(c => c !== numericCol) || columns[0];

        if (numericCol && labelCol && rawDataRows.length <= 50) {
          finalChart = {
            "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
            "data": { "values": rawDataRows.map(r => ({ [labelCol]: r[labelCol], [numericCol]: parseFloat(r[numericCol]) || 0 })) },
            "mark": "bar",
            "encoding": {
              "x": { "field": labelCol, "type": "nominal", "title": labelCol, "sort": "-y" },
              "y": { "field": numericCol, "type": "quantitative", "title": numericCol }
            },
            "width": 500,
            "height": 300
          };
          console.log('[AutoChart] Generated bar chart from data rows');
        }
      } catch (chartErr) {
        console.warn('[AutoChart] Failed to auto-generate chart:', chartErr.message);
      }
    }

    // Send structured response
    console.log('Sending response to frontend:', { replyLength: fullResponseText.length, hasChart: !!finalChart, hasSql: !!finalSql, hasData: rawDataRows.length > 0, conversationId: returnedConversationId });

    // If no text was extracted, provide helpful feedback
    if (!fullResponseText || fullResponseText.trim().length === 0) {
      fullResponseText = finalSql
        ? `I executed a query but couldn't generate a natural language response.\n\n**SQL Query:**\n\`\`\`sql\n${finalSql}\n\`\`\``
        : "I received your question but couldn't generate a response. This might be because:\n\n" +
        "1. The table doesn't contain data relevant to your question\n" +
        "2. The question requires data from a different table\n" +
        "3. The Conversational Analytics API returned an unexpected format\n\n" +
        "Try rephrasing your question or selecting additional related tables.";
    }

    // --- GEMINI 3.0 SYNTHESIS ---
    let synthesizedReply = fullResponseText;

    // If we have data rows but sparse natural language, let Gemini explain
    if (rawDataRows && rawDataRows.length > 0 && fullResponseText.length < 200) {
      try {
        console.log(`[Gemini 3] Synthesizing ${rawDataRows.length} rows of data...`);
        const synthesisLocation = (process.env.GCP_LOCATION && process.env.GCP_LOCATION.includes('-')) ? process.env.GCP_LOCATION : 'us-central1';
        const synthesizerVertex = new VertexAI({
          project: PROJECT_ID,
          location: synthesisLocation
        });
        const synthesizerModel = synthesizerVertex.getGenerativeModel({
          model: 'gemini-2.5-flash',
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
        });

        const synthesisPrompt = `
          You are an expert Data Steward.
          The user asked: "${message}"

          The database executed this SQL: 
          ${finalSql}

          And returned this data (showing first 10 rows):
          ${JSON.stringify(rawDataRows.slice(0, 10))}

          Task:
          1. Answer the user's question conversationally using this data.
          2. Do not just output a table.
          3. Highlight key insights, totals, or trends.
          4. If the data is empty, explain why.
        `;

        const result = await synthesizerModel.generateContent(synthesisPrompt);
        synthesizedReply = result.response.candidates[0].content.parts[0].text;
        console.log('[Gemini 3] Synthesis complete');
      } catch (synthErr) {
        console.error('[Gemini 3] Synthesis failed:', synthErr.message);
        // Fallback to original text if synthesis fails
      }
    }

    // Note: With stateful mode, Google manages the conversation history.
    // We just need to return the conversation ID for the frontend to track.

    res.json({
      reply: synthesizedReply,
      chart: finalChart,
      sql: finalSql,
      data: rawDataRows,
      conversationId: returnedConversationId // For stateful mode - frontend stores this
    });

  } catch (err) {
    console.error("Conversational Analytics API Error:", err.message);

    // --- FALLBACK MECHANISM ---
    // If the specialized API fails (Auth, 404, etc.), fallback to standard Gemini 1.5 Flash
    // This ensures the user always gets an answer.
    try {
      console.log('Attempting fallback to Gemini 1.5 Flash...');
      // Vertex AI requires a specific region (not multi-region like 'us'), default to us-central1
      const fallbackLocation = (process.env.GCP_LOCATION && process.env.GCP_LOCATION.includes('-')) ? process.env.GCP_LOCATION : 'us-central1';
      const fallbackVertex = new VertexAI({
        project: PROJECT_ID,
        location: fallbackLocation
      });
      const fallbackModel = fallbackVertex.getGenerativeModel({ model: 'gemini-2.5-flash' });

      // Construct context for the LLM
      let schemaContext = '';
      if (context.tables && context.tables.length > 0) {
        // Multi-table context
        schemaContext = context.tables.map(t =>
          `Table: ${t.name}\nDescription: ${t.description || ''}\nFQN: ${t.fullyQualifiedName}`
        ).join('\n\n');
      } else {
        // Single table context
        schemaContext = `Table: ${context.name}\nDescription: ${context.description}\nSchema: ${JSON.stringify(context.schema || [])}`;
      }

      const fallbackPrompt = `
        You are a Data Steward assistant. The user asked a question about the following data:
        ${schemaContext}

        User Question: ${message}

        Answer concisely based on the metadata provided.
      `;

      const result = await fallbackModel.generateContent(fallbackPrompt);
      const fallbackText = result.response.candidates[0].content.parts[0].text;

      console.log('Fallback successful');
      return res.status(200).json({
        reply: fallbackText,
        chart: null,
        sql: null,
        fallback: true
      });

    } catch (fallbackErr) {
      console.error("Fallback also failed:", fallbackErr.message);

      // Original error handling if fallback fails
      if (err.response && err.response.data) {
        try {
          const errorMsg = Buffer.from(err.response.data).toString('utf8');
          console.error("FULL API ERROR MESSAGE:", errorMsg);
        } catch (decodeErr) {
          console.error("Could not decode error buffer:", decodeErr);
        }
      }

      res.status(200).json({
        reply: "I'm sorry, I encountered an error connecting to the analytics service. Please try again later.",
        error: true,
        details: err.message
      });
    }
  }
});
// --- END CONVERSATIONAL ANALYTICS CODE ---



const PORT = process.env.PORT || 8080;



// Serve static files from the React build folder
app.use(express.static(path.join(__dirname, 'dist')));

// --- File Path for Local Data ---
const dataFilePath = path.join(__dirname, 'configData.json');


/**
 * POST /api/v1/ai-search
 * AI-powered natural language search for tables and assets using Vertex AI
 *
 * Request Body:
 * {
 *   "query": "Natural language query like 'tables about customer orders' or 'sales data'"
 *   "type": "table" | "asset" | "all" (optional, defaults to "all")
 * }
 */
app.post('/api/v1/ai-search', async (req, res) => {
  try {
    const { query, type = 'all' } = req.body;
    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'europe-west1';

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Query is required and must be at least 2 characters.' });
    }

    // Step 1: Use Gemini to understand the query and generate search terms
    const vertex_ai = new VertexAI({
      project: projectId,
      location: process.env.GCP_LOCATION || 'us-central1'
    });
    const generativeModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const aiPrompt = `You are a data catalog search assistant. Given a user's natural language query, extract the key search terms and concepts that would help find relevant database tables or datasets.

User Query: "${query}"

Analyze the query and return a JSON object with:
1. "searchTerms": array of individual keywords to search for (lowercase, no special characters)
2. "dataplexQuery": a search query string optimized for Dataplex/Data Catalog search
3. "intent": what the user is looking for (e.g., "customer data", "sales metrics", "order history")
4. "suggestedFilters": any filters to apply (e.g., entryType, system)

Return ONLY valid JSON, no markdown or explanations.
Example output: {"searchTerms":["customer","orders","purchase"],"dataplexQuery":"customer orders purchase","intent":"customer order data","suggestedFilters":{}}`;

    const aiResult = await generativeModel.generateContent(aiPrompt);
    const aiResponseText = aiResult.response.candidates[0].content.parts[0].text.trim();

    let searchConfig;
    try {
      // Clean markdown if present
      let cleanJson = aiResponseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      searchConfig = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('AI response parse error:', parseError, 'Response:', aiResponseText);
      // Fallback to simple search
      searchConfig = {
        searchTerms: query.toLowerCase().split(/\s+/).filter(t => t.length > 2),
        dataplexQuery: query,
        intent: query,
        suggestedFilters: {}
      };
    }

    console.log('AI Search Config:', searchConfig);

    // Step 2: Search Dataplex with the AI-generated query
    const auth = new AdcGoogleAuth();
    const dataplexClient = new CatalogServiceClient({ auth });

    // Build search query based on type
    let searchQuery = searchConfig.dataplexQuery || query;
    if (type === 'table') {
      searchQuery += ' AND (type="bigquery_table" OR type="TABLE")';
    } else if (type === 'asset') {
      searchQuery += ' AND NOT type="data_product"';
    }

    const searchRequest = {
      name: `projects/${projectId}/locations/global`,
      query: searchQuery,
      pageSize: 20
    };

    console.log('Dataplex Search Request:', searchRequest);

    const [searchResponse] = await dataplexClient.searchEntries(searchRequest);
    let results = searchResponse.results || [];

    // Step 3: If we have results, use Gemini to rank them by relevance
    if (results.length > 0) {
      const rankPrompt = `Given the user's search intent: "${searchConfig.intent}"

Rank these data entries by relevance (most relevant first). Return a JSON array of indices in order of relevance.

Entries:
${results.slice(0, 15).map((r, i) => {
        const entry = r.dataplexEntry || r;
        return `${i}. Name: ${entry.entrySource?.displayName || entry.name?.split('/').pop() || 'Unknown'}
     Description: ${entry.entrySource?.description || 'No description'}
     Type: ${entry.entryType || 'Unknown'}`;
      }).join('\n')}

Return ONLY a JSON array of indices like [2,0,5,1,3,4,...], no explanation.`;

      try {
        const rankResult = await generativeModel.generateContent(rankPrompt);
        const rankText = rankResult.response.candidates[0].content.parts[0].text.trim();
        const cleanRankJson = rankText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const rankedIndices = JSON.parse(cleanRankJson);

        if (Array.isArray(rankedIndices)) {
          const rankedResults = rankedIndices
            .filter(i => i >= 0 && i < results.length)
            .map(i => results[i]);
          // Add any results that weren't ranked
          const unrankedResults = results.filter((_, i) => !rankedIndices.includes(i));
          results = [...rankedResults, ...unrankedResults];
        }
      } catch (rankError) {
        console.log('Ranking failed, using original order:', rankError.message);
      }
    }

    // Step 4: Format response
    const formattedResults = results.map(r => {
      const entry = r.dataplexEntry || r;
      return {
        name: entry.name,
        displayName: entry.entrySource?.displayName || entry.name?.split('/').pop() || 'Unknown',
        description: entry.entrySource?.description || '',
        fullyQualifiedName: entry.fullyQualifiedName || '',
        entryType: entry.entryType || 'Unknown',
        system: entry.entrySource?.system || '',
        location: entry.name?.split('/locations/')[1]?.split('/')[0] || ''
      };
    });

    res.json({
      query: query,
      intent: searchConfig.intent,
      searchTerms: searchConfig.searchTerms,
      results: formattedResults,
      totalResults: formattedResults.length
    });

  } catch (error) {
    console.error('AI Search error:', error);
    res.status(500).json({
      error: 'An error occurred during AI-powered search.',
      details: error.message
    });
  }
});

/**
 * POST /check-iam-role
 * Checks if a given email has a specific role on a Google Cloud Project.
 *
 * Request Body:
 * {
    * "projectId": "your-gcp-project-id", // e.g., "my-project-12345"
    * "email": "user-to-check@example.com", // The email of the user/service account
    * "role": "roles/viewer" // The specific IAM role to check, e.g., "roles/editor", "roles/compute.instanceAdmin"
 * }
 *
 * Response:
 * {
 * "hasRole": true, // or false
 * "message": "..."
 * }
 */

app.post('/api/v1/check-iam-role', async (req, res) => {

  const { email, role } = req.body;
  // const accessToken = req.headers.authorization?.split(' ')[1]; // Expect
  const projectId = PROJECT_ID; // Use environment variable if not provided

  // --- Input Validation ---
  if (!projectId || typeof projectId !== 'string' || projectId.trim() === '') {
    return res.status(400).json({ error: 'projectId is required and must be a non-empty string.' });
  }
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({ error: 'email is required and must be a non-empty string.' });
  }
  if (!role || typeof role !== 'string' || role.trim() === '') {
    return res.status(400).json({ error: 'role is required and must be a non-empty string.' });
  }

  // Ensure the email is in the correct format for IAM members (e.g., "user:email@example.com", "serviceAccount:id@project.iam.gserviceaccount.com")
  const member = email.includes(':') ? email : `user:${email}`;

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    // Get the Cloud Resource Manager API client
    const cloudResourceManager = google.cloudresourcemanager({
      version: 'v1',
      auth: auth,
    });

    // Fetch the IAM policy for the specified project
    console.log(`Fetching IAM policy for project: ${projectId}`);
    const response = await cloudResourceManager.projects.getIamPolicy({
      resource: projectId
    });

    const policy = response.data;
    console.log(`IAM Policy fetched for project ${projectId}.`);

    let hasRole = false;

    const userRoles = [];

    // Iterate through the policy bindings to find the role and member
    if (policy && policy.bindings) {
      for (const binding of policy.bindings || []) {
        if ((binding.members || []).includes(member)) {
          userRoles.push(binding.role);
        }
      }
      console.log(`Roles found for user ${email} in project ${projectId}:`, userRoles);
      // Check if the requested role is in the user's roles
      if (userRoles.includes(role) || userRoles.includes(`roles/owner`)) {
        hasRole = true;
      }
    }

    let permissions = [];

    // Expand each role into permissions (to simulate sub-roles)
    for (const role of userRoles) {
      console.log(`\n🔹 Role: ${role}`);
      try {
        const roleName = role.startsWith('roles/') ? `projects/${projectId}/roles/${role.split('/')[1]}` : role;

        const res = await iam.roles.get({
          name: role.startsWith('roles/') ? role : roleName,
        });

        permissions = res.data.includedPermissions || [];
        //console.log(`   Includes ${permissions.length} permissions`);
        //console.log(`   Sample permissions: ${permissions.slice(0, 5).join(', ')}${permissions.length > 5 ? '...' : ''}`);
      } catch (err) {
        console.warn(`   Could not retrieve details for role ${role}:`, err.message);
      }
    }

    if (hasRole) {
      console.log(`User ${email} HAS role ${role} on project ${projectId}.`);
      return res.json({ hasRole: true, roles: userRoles, permissions: permissions, message: `User ${email} has role ${role} on project ${projectId}.` });
    } else {
      console.log(`User ${email} DOES NOT HAVE role ${role} on project ${projectId}.`);
      return res.json({ hasRole: false, roles: userRoles, permissions: permissions, message: `User ${email} does not have role ${role} on project ${projectId}.` });
    }

  } catch (error) {
    console.error('Error checking IAM role:', error.message);
    // Provide a more specific error message if it's a permission denied error
    if (error.code === 403 || (error.errors && error.errors[0] && error.errors[0].reason === 'FORBIDDEN')) {
      return res.status(403).json({
        error: 'Permission Denied: The service account does not have the necessary permissions to get IAM policy for this project.',
        details: error.message
      });
    }
    return res.status(500).json({ error: 'An internal server error occurred.', details: error.message });
  }
});

/**
 * OLD SEARCH ENDPOINT - COMMENTED OUT
 * This was superseded by the new search endpoint with SUPER_ADMIN bypass and IAM filtering
 * See: POST /api/v1/search below (around line 2453)
 */
// app.post('/api/v1/search', async (req, res) => {
//   // OLD HANDLER - DISABLED. The new handler with permission filtering is used instead.
//   // See the second /api/v1/search endpoint below.
// });

/**
 * POST /api/aspects
 * A protected endpoint to fetch all aspects (detailed metadata like schema) for a specific Dataplex entry.
 * The user must be authenticated.
 *
 * Request Body:
 * {
 * "entryName": "The full resource name of the Dataplex entry. e.g., projects/{p}/locations/{l}/entryGroups/{eg}/entries/{e}"
 * }
 */
app.post('/api/v1/aspects', async (req, res) => {
  const { entryName } = req.body;
  // const accessToken = req.headers.authorization?.split(' ')[1]; // Expect

  // Validate that an entryName was provided
  if (!entryName) {
    return res.status(400).json({ message: 'Bad Request: An "entryName" field is required in the request body.' });
  }

  try {

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });
    // Construct the request to get a specific entry.
    // The `view` is set to 'FULL' to ensure all aspects are returned.
    const request = {
      name: entryName,
      view: 'FULL',
    };

    console.log(`Fetching aspects for entry: ${entryName}`);

    // Call the getEntry method of the Dataplex client
    const [entry] = await dataplexClientv1.getEntry(request);

    // The aspects are contained within the 'aspects' property of the entry object.
    // If the property exists, return it, otherwise return an empty object.
    res.json(entry.aspects || {});

  } catch (error) {
    console.error(`Error fetching aspects for entry ${entryName}:`, error);
    // Return a generic error message to the client
    res.status(500).json({ message: 'An error occurred while fetching aspects from Dataplex.', details: error.message });
  }
});

/**
 * POST /api/v1/get-entry
 * A protected endpoint to fetch full details for a specific Dataplex entry.
 * The user must be authenticated.
 */
app.post('/api/v1/get-entry', async (req, res) => {
  const { entryName } = req.body;
  const accessToken = req.headers.authorization?.split(' ')[1];

  if (!entryName) {
    return res.status(400).json({ message: 'Bad Request: An "entryName" field is required.' });
  }

  try {
    const oauth2Client = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({ auth: oauth2Client });

    const request = { name: entryName, view: 'FULL' };
    console.log(`Fetching full entry: ${entryName}`);

    const [entry] = await dataplexClientv1.getEntry(request);
    res.json(entry);

  } catch (error) {
    console.error(`Error fetching entry ${entryName}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching entry from Dataplex.', details: error.message });
  }
});

/**
 * POST /api/v1/update-entry-aspects
 * Update aspects on a Dataplex entry (e.g., contacts, custom aspects)
 * Body: { entryName: string, aspects: { [aspectKey]: aspectData }, updateMask: string[] }
 */
app.post('/api/v1/update-entry-aspects', async (req, res) => {
  try {
    const { entryName, aspects, updateMask } = req.body;

    if (!entryName) {
      return res.status(400).json({ message: 'Bad Request: entryName is required.' });
    }

    if (!aspects || Object.keys(aspects).length === 0) {
      return res.status(400).json({ message: 'Bad Request: aspects object is required.' });
    }

    // ADC Auth
    const auth = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({ auth });

    // Build the update request
    const request = {
      entry: {
        name: entryName,
        aspects: aspects
      },
      updateMask: {
        paths: updateMask || Object.keys(aspects).map(key => `aspects.${key}`)
      }
    };

    console.log('Updating entry aspects:', JSON.stringify(request, null, 2));

    const [updatedEntry] = await dataplexClientv1.updateEntry(request);

    res.json({
      success: true,
      message: 'Entry aspects updated successfully',
      entry: updatedEntry
    });

  } catch (error) {
    console.error('Error updating entry aspects:', error);
    res.status(500).json({
      message: 'An error occurred while updating entry aspects.',
      details: error.message
    });
  }
});

/**
 * POST /api/v1/data-products
 * Create a new Data Product in Dataplex
 * Body: { name, displayName, description, location, entryGroupId }
 */
app.post('/api/v1/data-products', async (req, res) => {
  try {
    const { displayName, description, location, entryGroupId } = req.body;
    const projectId = PROJECT_ID;

    if (!displayName) {
      return res.status(400).json({ message: 'Bad Request: displayName is required.' });
    }

    // Use provided location or default from env
    const loc = location || process.env.GCP_LOCATION || 'europe-west1';
    const entryGroup = entryGroupId || '@dataplex';

    // ADC Auth
    const auth = new AdcGoogleAuth();
    const dataplexClient = new CatalogServiceClient({ auth });

    // Generate entry ID from display name (sanitize for Dataplex)
    const entryId = displayName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 63);

    const parent = `projects/${projectId}/locations/${loc}/entryGroups/${entryGroup}`;

    // Create timestamp in Protobuf format (gRPC requires this, not ISO strings)
    const now = new Date();
    const timestamp = { seconds: Math.floor(now.getTime() / 1000), nanos: 0 };

    const request = {
      parent,
      entryId,
      entry: {
        entryType: `projects/${projectId}/locations/${loc}/entryTypes/data-product`,
        entrySource: {
          displayName: displayName,
          description: description || '',
          system: 'CUSTOM',
          createTime: timestamp,
          updateTime: timestamp
        },
        aspects: {}
      }
    };

    console.log('Creating Data Product:', JSON.stringify(request, null, 2));

    const [dataProduct] = await dataplexClient.createEntry(request);

    res.json({
      success: true,
      message: 'Data Product created successfully',
      dataProduct,
      location: loc
    });

  } catch (error) {
    console.error('Error creating data product:', error);
    res.status(500).json({
      message: 'An error occurred while creating the data product.',
      details: error.message
    });
  }
});

/**
 * POST /api/v1/data-products/assets
 * Add assets to a Data Product
 * Body: { dataProductName, assets: [{ entryName, displayName }] }
 */
app.post('/api/v1/data-products/assets', async (req, res) => {
  try {
    const { dataProductName, assets } = req.body;

    if (!dataProductName) {
      return res.status(400).json({ message: 'Bad Request: dataProductName is required.' });
    }

    if (!assets || !Array.isArray(assets) || assets.length === 0) {
      return res.status(400).json({ message: 'Bad Request: assets array is required.' });
    }

    // ADC Auth
    const auth = new AdcGoogleAuth();
    const dataplexClient = new CatalogServiceClient({ auth });

    // First, get the current data product to check its location
    const [dataProduct] = await dataplexClient.getEntry({
      name: dataProductName,
      view: protos.google.cloud.dataplex.v1.EntryView.ALL
    });

    // Extract location from data product name
    const dpLocation = dataProductName.split('/locations/')[1]?.split('/')[0];

    // Validate all assets are in the same region
    const invalidAssets = assets.filter(asset => {
      const assetLocation = asset.entryName?.split('/locations/')[1]?.split('/')[0];
      return assetLocation && assetLocation !== dpLocation;
    });

    if (invalidAssets.length > 0) {
      return res.status(400).json({
        message: `Assets must be in the same region as the Data Product (${dpLocation})`,
        invalidAssets: invalidAssets.map(a => ({
          name: a.displayName || a.entryName,
          location: a.entryName?.split('/locations/')[1]?.split('/')[0]
        }))
      });
    }

    // Update the data product with asset references
    // The exact structure depends on your data product aspect schema
    const projectId = PROJECT_ID;
    const aspectKey = `${projectId}.${dpLocation}.data-product-assets`;

    const assetReferences = assets.map(asset => ({
      entryReference: asset.entryName,
      displayName: asset.displayName || asset.entryName.split('/').pop()
    }));

    // Get existing assets if any
    const existingAssets = dataProduct.aspects?.[aspectKey]?.data?.assets || [];
    const mergedAssets = [...existingAssets, ...assetReferences];

    const updateRequest = {
      entry: {
        name: dataProductName,
        aspects: {
          [aspectKey]: {
            data: {
              assets: mergedAssets
            }
          }
        }
      },
      updateMask: {
        paths: [`aspects.${aspectKey}`]
      }
    };

    const [updatedDataProduct] = await dataplexClient.updateEntry(updateRequest);

    res.json({
      success: true,
      message: `Added ${assets.length} asset(s) to data product`,
      dataProduct: updatedDataProduct
    });

  } catch (error) {
    console.error('Error adding assets to data product:', error);
    res.status(500).json({
      message: 'An error occurred while adding assets to the data product.',
      details: error.message
    });
  }
});

/**
 * GET /api/v1/entries-by-location
 * Get all entries in a specific location (for filtering assets by region)
 */
app.get('/api/v1/entries-by-location', async (req, res) => {
  try {
    const location = req.query.location || process.env.GCP_LOCATION;
    const projectId = PROJECT_ID;
    const entryType = req.query.entryType; // Optional: filter by entry type (TABLE, VIEW, etc.)

    const auth = new AdcGoogleAuth();
    const dataplexClient = new CatalogServiceClient({ auth });

    // Search for entries in the specific location
    const parent = `projects/${projectId}/locations/${location}`;

    let query = `location=${location}`;
    if (entryType) {
      query += ` entryType=${entryType}`;
    }

    const request = {
      name: parent,
      query: query,
      pageSize: 100
    };

    const [response] = await dataplexClient.searchEntries(request);

    res.json({
      entries: response.results || [],
      location: location
    });

  } catch (error) {
    console.error('Error fetching entries by location:', error);
    res.status(500).json({
      message: 'An error occurred while fetching entries.',
      details: error.message
    });
  }
});

app.post('/api/v1/batch-aspects', async (req, res) => {
  const { entryNames } = req.body;
  // const accessToken = req.headers.authorization?.split(' ')[1]; // Expect

  // Validate that entryNames is provided and is an array
  if (!entryNames || !Array.isArray(entryNames)) {
    return res.status(400).json({ message: 'Bad Request: An "entryNames" field (array of strings) is required.' });
  }

  // if (entryNames.length === 0) {
  //     return res.json([]);
  // }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });
    console.log(`Fetching aspects for a batch of ${entryNames.length} entries.`);

    // Create an array of promises, where each promise fetches one entry
    const promises = entryNames.map(n => {
      //const request = { name, view: protos.google.cloud.dataplex.v1.EntryView.ALL };
      return dataplexClientv1.getAspectType({ name: n });
    });

    // Execute all promises concurrently
    const results = await Promise.all(promises);

    // Map the results to a more user-friendly format
    let aspectsResponse = {};
    results.forEach(([aspectType], index) => {
      aspectsResponse[aspectType.displayName ?? entryNames[index]] = aspectType.metadataTemplate?.recordFields?.map(f => f.name);
    });

    res.json(aspectsResponse);

  } catch (error) {
    console.error('Error fetching aspects for batch:', error);
    res.status(500).json({ message: 'An error occurred while fetching aspects for the batch.', details: error.message });
  }
});

/**
 * GET /api/aspect-types
 * A protected endpoint to list all available Aspect Types in a given location.
 * The user must be authenticated.
 */
app.get('/api/v1/aspect-types', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const configuredLocation = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId) {
      console.error('[ASPECT-TYPES] No project ID configured');
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID must be set.' });
    }

    // Define locations to check - include configured one and common defaults including EU
    const locationsToFetch = Array.from(new Set([
      configuredLocation,
      'global',
      'us-central1',
      'us',
      'europe-west1',
      'europe-west2',
      'europe-west3',
      'europe-west4',
      'eu'
    ]));

    console.log(`[ASPECT-TYPES] Fetching from multiple locations: ${locationsToFetch.join(', ')}`);

    const auth = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({ auth: auth });

    const fetchPromises = locationsToFetch.map(async (loc) => {
      try {
        const parent = `projects/${projectId}/locations/${loc}`;
        const [aspects] = await dataplexClientv1.listAspectTypes({ parent });
        console.log(`[ASPECT-TYPES] Found ${aspects.length} types in ${loc}`);
        return aspects;
      } catch (err) {
        console.warn(`[ASPECT-TYPES] Failed to fetch from ${loc}:`, err.message);
        return [];
      }
    });

    const resultsArray = await Promise.all(fetchPromises);

    // Merge results and remove duplicates by name
    const allAspects = resultsArray.flat();
    const uniqueAspectsMap = new Map();
    allAspects.forEach(aspect => {
      if (!uniqueAspectsMap.has(aspect.name)) {
        uniqueAspectsMap.set(aspect.name, aspect);
      }
    });

    const finalAspectsList = Array.from(uniqueAspectsMap.values());
    console.log(`[ASPECT-TYPES] Returning ${finalAspectsList.length} unique aspect types.`);

    res.json(finalAspectsList);

  } catch (error) {
    console.error('Error listing aspect types:', error);
    res.status(500).json({ message: 'An error occurred while listing aspect types from Dataplex.', details: error.message });
  }
});

/**
 * GET /api/entry-list
 * A protected endpoint to list all available Aspect Types in a given location.
 * The user must be authenticated.
 */
app.get('/api/v1/entry-list', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const configuredLocation = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId) {
      console.error('[ENTRY-LIST] No project ID configured');
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID must be set.' });
    }

    const locationsToFetch = Array.from(new Set([
      configuredLocation,
      'global',
      'us-central1',
      'us',
      'europe-west1',
      'europe-west2',
      'europe-west3',
      'europe-west4',
      'eu'
    ]));
    const auth = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({ auth: auth });

    console.log(`[ENTRY-LIST] Fetching from multiple locations: ${locationsToFetch.join(', ')}`);

    const fetchPromises = locationsToFetch.map(async (loc) => {
      try {
        const parent = `projects/${projectId}/locations/${loc}`;
        const [entries] = await dataplexClientv1.listEntries({ parent });
        console.log(`[ENTRY-LIST] Found ${entries.length} entries in ${loc}`);
        return entries;
      } catch (err) {
        console.warn(`[ENTRY-LIST] Failed to fetch from ${loc}:`, err.message);
        return [];
      }
    });

    const resultsArray = await Promise.all(fetchPromises);
    const allEntries = resultsArray.flat();
    const uniqueEntriesMap = new Map();
    allEntries.forEach(entry => {
      if (!uniqueEntriesMap.has(entry.name)) {
        uniqueEntriesMap.set(entry.name, entry);
      }
    });

    const finalEntriesList = Array.from(uniqueEntriesMap.values());
    console.log(`[ENTRY-LIST] Returning ${finalEntriesList.length} unique entries.`);
    res.json(finalEntriesList);

  } catch (error) {
    console.error('Error listing entries:', error);
    res.status(500).json({ message: 'An error occurred while listing entries.', details: error.message });
  }
});

/**
 * GET /api/aspect-types
 * A protected endpoint to list all available Aspect Types in a given location.
 * The user must be authenticated.
 */
app.get('/api/v1/entry-types', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const configuredLocation = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId) {
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID must be set.' });
    }

    const locationsToFetch = Array.from(new Set([configuredLocation, 'us-central1', 'europe-west1', 'global', 'us']));
    const auth = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({ auth: auth });

    console.log(`[ENTRY-TYPES] Fetching from multiple locations: ${locationsToFetch.join(', ')}`);

    const fetchPromises = locationsToFetch.map(async (loc) => {
      try {
        const parent = `projects/${projectId}/locations/${loc}`;
        const [types] = await dataplexClientv1.listEntryTypes({ parent });
        console.log(`[ENTRY-TYPES] Found ${types.length} types in ${loc}`);
        return types;
      } catch (err) {
        console.warn(`[ENTRY-TYPES] Failed to fetch from ${loc}:`, err.message);
        return [];
      }
    });

    const resultsArray = await Promise.all(fetchPromises);
    const allTypes = resultsArray.flat();
    const uniqueTypesMap = new Map();
    allTypes.forEach(type => {
      if (!uniqueTypesMap.has(type.name)) {
        uniqueTypesMap.set(type.name, type);
      }
    });

    const finalTypesList = Array.from(uniqueTypesMap.values());
    console.log(`[ENTRY-TYPES] Returning ${finalTypesList.length} unique entry types.`);
    res.json(finalTypesList);

  } catch (error) {
    console.error('Error listing entry types:', error);
    res.status(500).json({ message: 'An error occurred while listing entry types.', details: error.message });
  }
});


/**
 * GET /api/get-entry
 * A protected endpoint to list all available Aspect Types in a given location.
 * The user must be authenticated.
 */
app.get('/api/v1/get-entry', async (req, res) => {
  try {

    const entryName = req.query.entryName; // Get entryName from query parameters
    // const accessToken = req.headers.authorization?.split(' ')[1]; // Expect

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    if (!entryName) {
      return res.status(500).json({ message: 'Entry name is required' });
    }

    // The getEntry method returns an entry.
    const [entry] = await dataplexClientv1.getEntry({ name: entryName, view: protos.google.cloud.dataplex.v1.EntryView.ALL });

    res.json(entry);

  } catch (error) {
    console.error('Error fetching entry', error);
    res.status(500).json({ message: 'An error occurred while fetching entry from Dataplex.', details: error.message });
  }
});

/**
 * GET /api/v1/aspect/:urn
 * A protected endpoint to fetch a specific aspect by its URN.
 * The user must be authenticated.
 */
app.get('/api/v1/aspect/:urn', async (req, res) => {
  try {
    const { urn } = req.params;
    // const accessToken = req.headers.authorization?.split(' ')[1];

    if (!urn) {
      return res.status(400).json({ message: 'Bad Request: An "urn" parameter is required.' });
    }

    // ADC Auth
    const auth = new AdcGoogleAuth();
    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    // Get the aspect type by URN
    const [aspectType] = await dataplexClientv1.getAspectType({ name: urn });
    res.json(aspectType);

  } catch (error) {
    console.error(`Error fetching aspect for URN ${urn}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching the aspect.', details: error.message });
  }
});

/**
 * GET /api/get-entry-by-fqn
 * A protected endpoint to list all available Aspect Types in a given location.
 * The user must be authenticated.
 */
app.get('/api/v1/get-entry-by-fqn', async (req, res) => {
  try {

    let query = `fully_qualified_name=${req.query.fqn}`;

    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION;
    // const accessToken = req.headers.authorization?.split(' ')[1]; // Expect

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });


    if (!projectId || !location) {
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID and GCP_LOCATION must be set in the .env file.' });
    }

    // Construct the request for the Dataplex API
    const request = {
      // The name of the project and location to search within
      name: `projects/${projectId}/locations/${location}`,
      query: query,
      pageSize: 10, // Limit the number of results returned
    };

    console.log('Performing Dataplex search with query:', query);

    // Call the searchEntries method of the Dataplex client
    const [response] = await dataplexClientv1.searchEntries(request);


    const entryName = response.length > 0 ? response[0].dataplexEntry.name : null; // Get entryName from query parameters

    if (!entryName) {
      return res.status(500).json({ message: 'FQN is not provided or incorrect' });
    }

    // The getEntry method returns an entry.
    const [entry] = await dataplexClientv1.getEntry({ name: entryName, view: protos.google.cloud.dataplex.v1.EntryView.ALL });

    res.json(entry);

  } catch (error) {
    console.error('Error fetching entry', error);
    res.status(500).json({ message: 'An error occurred while fetching entry from Dataplex.', details: error.message });
  }
});

app.get('/api/v1/lookup-entry', async (req, res) => {
  try {

    const entryName = req.query.entryName; // Get entryName from query parameters
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    if (!entryName) {
      return res.status(500).json({ message: 'Entry name is required' });
    }

    // The getEntry method returns an entry.
    const [entry] = await dataplexClientv1.lookupEntry({ name: entryName, view: protos.google.cloud.dataplex.v1.EntryView.ALL });

    res.json(entry);

  } catch (error) {
    console.error('Error fetching entry', error);
    res.status(500).json({ message: 'An error occurred while fetching entry from Dataplex.', details: error.message });
  }
});

app.get('/api/v1/get-sample-data', async (req, res) => {
  try {

    const fqn = req.query.fqn; // Get entryName from query parameters
    // ADC Auth
    const bigquery = new BigQuery({
      projectId: fqn.split(':')[1].split('.')[0],
    });

    const rows = await querySampleFromBigQuery(bigquery, fqn.split(':')[1], 10);

    res.json(rows);

  } catch (error) {
    console.error('Error fetching entry', error);
    res.status(500).json({ message: 'An error occurred while fetching sample data from bigquery.', details: error.message });
  }
});

/**
 * POST /api/lineage
 * A protected endpoint to fetch data lineage for a specific resource.
 *
 * Request Body:
 * {
 * "resourceName": "The fully qualified name of the target resource (e.g., //bigquery.googleapis.com/projects/p/datasets/d/tables/t)"
 * }
 */
app.post('/api/v1/lineage', async (req, res) => {
  const { parent, fqn } = req.body;

  if (!fqn && !parent) {
    return res.status(400).json({ message: 'Bad Request: A "fqn and parent" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexLineageClientv1 = new LineageClient({
      auth: auth,
    });

    //const parent = `projects/${projectId}/locations/us`;
    console.log(`Searching for lineage links targeting resource: ${fqn}`);

    // The searchLinks method returns an iterable. We'll collect all results.
    const source = dataplexLineageClientv1.searchLinks({
      parent: parent,
      source: {
        fullyQualifiedName: fqn,
      }
    });
    const target = dataplexLineageClientv1.searchLinks({
      parent: parent,
      target: {
        fullyQualifiedName: fqn,
      }
    });

    const [sourceLinks, targetLinks] = await Promise.all([
      source, target
    ]);

    const links = [...sourceLinks[0].map(s => s.name), ...targetLinks[0].map(t => t.name)];
    //let batchData = [];
    let sourceData = sourceLinks[0];
    let targetData = targetLinks[0];
    if (links.length > 0) {
      const batchProcess = dataplexLineageClientv1.batchSearchLinkProcesses({
        parent: parent,
        links: links,
        pageSize: 20
      });

      const [batchProcessLinks] = await Promise.all([
        batchProcess
      ]);

      if (batchProcessLinks[0].length > 0) {
        batchData = batchProcessLinks[0];
        const linkToProcessMap = {};

        batchProcessLinks[0].forEach(f => {
          f.links.forEach(l => {
            linkToProcessMap[l.link] = f.process;
          });
        });
        sourceData = sourceLinks[0].map(s => ({
          ...s,
          process: linkToProcessMap[s.name] || ""
        }));

        targetData = targetLinks[0].map(s => ({
          ...s,
          process: linkToProcessMap[s.name] || ""
        }));
      }
    }


    res.json({ sourceLinks: sourceData, targetLinks: targetData });//, batchSearchLinkProcesses : batchData});

  } catch (error) {
    console.error('Error searching for lineage links:', error);
    res.status(500).json({ message: 'An error occurred while fetching data lineage.', details: error.message });
  }
});

app.post('/api/v1/lineage-downstream', async (req, res) => {
  const { parent, fqn } = req.body;

  if (!fqn && !parent) {
    return res.status(400).json({ message: 'Bad Request: A "fqn and parent" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexLineageClientv1 = new LineageClient({
      auth: auth,
    });

    //const parent = `projects/${projectId}/locations/us`;
    console.log(`Searching for lineage links targeting resource: ${fqn}`);

    // The searchLinks method returns an iterable. We'll collect all results.
    const [sourceLinks] = await dataplexLineageClientv1.searchLinks({
      parent: parent,
      source: {
        fullyQualifiedName: fqn,
      }
    });

    res.json({ sourceLinks: sourceLinks[0] });

  } catch (error) {
    console.error('Error searching for lineage links:', error);
    res.status(500).json({ message: 'An error occurred while fetching data lineage.', details: error.message });
  }
});

app.post('/api/v1/lineage-upstream', async (req, res) => {
  const { parent, fqn } = req.body;

  if (!fqn && !parent) {
    return res.status(400).json({ message: 'Bad Request: A "fqn and parent" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexLineageClientv1 = new LineageClient({
      auth: auth,
    });

    //const parent = `projects/${projectId}/locations/us`;
    console.log(`Searching for lineage links targeting resource: ${fqn}`);

    // The searchLinks method returns an iterable. We'll collect all results.
    const [targetLinks] = await dataplexLineageClientv1.searchLinks({
      parent: parent,
      target: {
        fullyQualifiedName: fqn,
      }
    });

    res.json({ targetLinks: targetLinks[0] });//, batchSearchLinkProcesses : batchProcessLinks});

  } catch (error) {
    console.error('Error searching for lineage links:', error);
    res.status(500).json({ message: 'An error occurred while fetching data lineage.', details: error.message });
  }
});

app.post('/api/v1/lineage-processes', async (req, res) => {
  const { parent } = req.body;

  if (!parent) {
    return res.status(400).json({ message: 'Bad Request: A "parent" field is required.' });
  }

  try {
    const accessToken = req.headers.authorization?.split(' ')[1]; // Expect

    const oauth2Client = new AdcGoogleAuth();

    const dataplexLineageClientv1 = new LineageClient({
      auth: oauth2Client,
    });

    //const parent = `projects/${projectId}/locations/us`;
    console.log(`Searching for lineage links targeting resource: ${fqn}`);

    // The searchLinks method returns an iterable. We'll collect all results.
    const [processes] = await dataplexLineageClientv1.listProcesses({
      parent: parent
    });

    res.json({ processes: processes });

  } catch (error) {
    console.error('Error searching for lineage links:', error);
    res.status(500).json({ message: 'An error occurred while fetching data lineage.', details: error.message });
  }
});

app.post('/api/v1/get-process-and-job-details', async (req, res) => {
  const { process } = req.body;

  if (!process) {
    return res.status(400).json({ message: 'Bad Request: A "process" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexLineageClientv1 = new LineageClient({
      auth: auth,
    });

    // The searchLinks method returns an iterable. We'll collect all results.

    const getProcess = dataplexLineageClientv1.getProcess({
      name: process
    });
    const listProcessRuns = dataplexLineageClientv1.listRuns({
      parent: process,
      pageSize: 50
    });

    const [processDetails, processRuns] = await Promise.all([
      getProcess, listProcessRuns
    ]);
    const projectId = processDetails[0].origin.name.split(':')[0];

    const bigquery = new BigQuery({
      projectId: projectId,
    });
    const jobId = processDetails[0].attributes.bigquery_job_id.stringValue;

    const jobDetails = await bigquery.job(jobId).get();

    res.json({ processDetails: processDetails[0], processRuns: processRuns[0], jobDetails: jobDetails });//, batchSearchLinkProcesses : batchProcessLinks});

  } catch (error) {
    console.error('Error searching for lineage links:', error);
    res.status(500).json({ message: 'An error occurred while fetching data lineage query.', details: error.message });
  }
});

app.get('/api/v1/projects', async (req, res) => {
  try {
    console.log('Listing all accessible GCP projects.');
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const resourceManagerClient = new ProjectsClient({
      auth: auth,
    });

    // The searchProjects method returns an iterable. We'll collect all results into an array.
    const projects = await resourceManagerClient.searchProjects();

    res.json(projects[0]); // The response is an array where the first element contains the list of projects.

  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ message: 'An error occurred while listing projects.', details: error.message });
  }
});

/**
 * GET /api/tag-templates
 * A protected endpoint to list all Tag Templates in a given location using Data Catalog.
 */
app.get('/api/v1/tag-templates', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId || !location) {
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID and GCP_LOCATION must be set in the .env file.' });
    }

    // The parent for Data Catalog resources includes the project and location.
    const parent = `projects/${projectId}/locations/${location}`;
    console.log(`Listing tag templates for parent: ${parent}`);
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataCatalogClientv1 = new DataCatalogClient({
      auth: auth,
    });


    // The listTagTemplates method returns an iterable. We'll collect all results into an array.
    const [templates] = await dataCatalogClientv1.listTagTemplates({ parent });

    res.json(templates);

  } catch (error) {
    console.error('Error listing tag templates:', error);
    res.status(500).json({ message: 'An error occurred while listing tag templates.', details: error.message });
  }
});

/**
 * POST /api/data
 * A protected endpoint to write data to a local data.json file.
 */
app.post('/api/v1/admin/configure', async (req, res) => {
  try {
    // The data to be written is the entire request body.
    const dataToWrite = req.body;
    // Convert the JSON object to a string with pretty printing (2-space indentation).
    const jsonString = JSON.stringify(dataToWrite, null, 2);
    // Write the string to the specified file path.
    await fs.writeFile(dataFilePath, jsonString, 'utf8');
    // Send a success response.
    res.status(200).json({ message: 'Data saved successfully.' });
  } catch (error) {
    console.error('Error writing data file:', error);
    res.status(500).json({ message: 'Failed to save data.', details: error.message });
  }
});

app.post('/api/v1/get-aspect-detail', async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Bad Request: A "name" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    const [aspectType] = await dataplexClientv1.getAspectType({ name: name });


    res.json(aspectType);

  } catch (error) {
    console.error('Error listing configs:', error);
    res.status(500).json({ message: 'An error occurred while getting aspect detail.', details: error.message });
  }
});

/**
 * GET /api/v1/get-aspect
 * A protected endpoint to fetch a specific aspect for an entity entry.
 * The user must be authenticated.
 *
 * Query Parameters:
 * - entryName: The full resource name of the Dataplex entry
 * - aspectType: The aspect type name to retrieve (optional, if not provided returns all aspects)
 */
app.get('/api/v1/get-aspect', async (req, res) => {
  const { entryName, aspectType } = req.query;
  const accessToken = req.headers.authorization?.split(' ')[1];

  // Validate that an entryName was provided
  if (!entryName) {
    return res.status(400).json({ message: 'Bad Request: An "entryName" query parameter is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    // Construct the request to get a specific entry with all aspects
    const request = {
      name: entryName,
      view: 'FULL',
    };

    console.log(`Fetching aspect${aspectType ? ` of type ${aspectType}` : 's'} for entry: ${entryName}`);

    // Call the getEntry method of the Dataplex client
    const [entry] = await dataplexClientv1.getEntry(request);

    // If a specific aspect type is requested, return only that aspect
    if (aspectType && entry.aspects) {
      // Find the aspect by type name
      const aspectKey = Object.keys(entry.aspects).find(key =>
        key.includes(aspectType) || key.endsWith(`_${aspectType}`)
      );

      if (aspectKey) {
        return res.json({ [aspectKey]: entry.aspects[aspectKey] });
      } else {
        return res.status(404).json({ message: `Aspect type "${aspectType}" not found for this entry.` });
      }
    }

    // Return all aspects if no specific type was requested
    res.json(entry.aspects || {});

  } catch (error) {
    console.error(`Error fetching aspect for entry ${entryName}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching aspect from Dataplex.', details: error.message });
  }
});

app.get('/api/v1/app-configs', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    const resourceManagerClientv1 = new ProjectsClient({
      auth: auth,
    });

    if (!projectId) {
      console.error('[APP-CONFIGS] No project ID configured');
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID must be set.' });
    }

    // Multi-region fetching for aspects - include EU regions
    const locationsToFetch = [
      location,
      'global',
      'us-central1',
      'us',
      'europe-west1',
      'europe-west2',
      'europe-west3',
      'europe-west4',
      'eu'
    ];

    const aspectQuery = `type=projects/dataplex-types/locations/global/entryTypes/aspecttype`;

    console.log(`[APP-CONFIGS] Fetching aspects from multiple locations: ${locationsToFetch.join(', ')}`);

    let projects = [];
    let aspects = [];
    let configData = {};

    try {
      // Fetch aspects from all locations in parallel
      const aspectPromises = locationsToFetch.map(async (loc) => {
        try {
          const parent = `projects/${projectId}/locations/${loc}`;
          const request = {
            name: parent,
            query: aspectQuery,
            pageSize: 999,
            pageToken: '',
          };
          const [aspectsList] = await dataplexClientv1.searchEntries(request, { autoPaginate: false });
          console.log(`[APP-CONFIGS] Found ${aspectsList ? aspectsList.length : 0} aspects in ${loc}`);
          return aspectsList || [];
        } catch (err) {
          console.warn(`[APP-CONFIGS] Failed to fetch aspects from ${loc}:`, err.message);
          return [];
        }
      });

      const [aspectResults, projectList, currentProject, defaultConfigData] = await Promise.all([
        Promise.all(aspectPromises),
        resourceManagerClientv1.searchProjects({ pageSize: 2000 }, { autoPaginate: false }),
        resourceManagerClientv1.getProject({ name: `projects/${projectId}` }),
        fs.readFile(dataFilePath, 'utf8').catch(() => '{}')
      ]);

      // Merge and deduplicate aspects from all regions
      const allAspects = aspectResults.flat();
      const uniqueAspectsMap = new Map();
      allAspects.forEach(aspect => {
        if (aspect && aspect.name && !uniqueAspectsMap.has(aspect.name)) {
          uniqueAspectsMap.set(aspect.name, aspect);
        }
      });
      aspects = Array.from(uniqueAspectsMap.values());
      console.log(`[APP-CONFIGS] Total unique aspects: ${aspects.length}`);

      let p = projectList[0] ? projectList[0].filter(pr => pr.projectId !== projectId) : [];
      projects = [currentProject[0], ...p];
      configData = defaultConfigData ? JSON.parse(defaultConfigData) : {};
    } catch (err) {
      console.error('[APP-CONFIGS] Error fetching configs:', err);
    }

    const reduceAspect = ({ name, fullyQualifiedName, entrySource, entryType }) => ({ name, fullyQualifiedName, entrySource, entryType });

    // Fetch user role if email is provided
    let userAdminRole = null;
    const userEmail = req.query.email || req.headers['x-user-email'];
    if (userEmail) {
      try {
        // 1. Check Firestore first
        userAdminRole = await adminService.getAdminRole(userEmail);

        // 2. If not in Firestore, check GCP IAM Roles (Alignment with GCP Rights)
        if (!userAdminRole) {
          const currentProjectId = PROJECT_ID;
          if (currentProjectId) {
            console.log(`Checking GCP IAM roles for ${userEmail} on ${currentProjectId}`);
            const isOwner = await verifyUserAccess(currentProjectId, userEmail, 'roles/owner');
            const isEditor = await verifyUserAccess(currentProjectId, userEmail, 'roles/editor');

            if (isOwner || isEditor) {
              console.log(`User ${userEmail} granted admin UI access via GCP IAM (${isOwner ? 'Owner' : 'Editor'})`);
              userAdminRole = {
                role: 'project-admin',
                assignedProjects: [currentProjectId],
                isGcpAligned: true
              };
            }
          }
        }
      } catch (err) {
        console.error('Error fetching user role for app config:', err);
      }
    }

    const configs = {
      aspects: aspects.map(({ dataplexEntry }) => ({ dataplexEntry: reduceAspect(dataplexEntry) })),
      projects: projects.map(({ projectId, name, displayName }) => ({ projectId, name, displayName })),
      defaultSearchProduct: configData.products || 'All',
      defaultSearchAssets: configData.assets || '',
      browseByAspectTypes: configData.aspectType || [],
      userRole: userAdminRole
    };

    res.json(configs);

  } catch (error) {
    console.error('Error listing configs:', error);
    res.status(401).json({ message: 'An error occurred while generating app configs.', details: error.message });
  }
});


app.post('/api/v1/send-feedback', async (req, res) => {

  try {
    const { message, requesterEmail, projectId, projectAdmin } = req.body;

    if (!requesterEmail || typeof requesterEmail !== 'string' || requesterEmail.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Requester email is required and must be a non-empty string'
      });
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Project ID is required and must be a non-empty string'
      });
    }

    if (projectAdmin && (!Array.isArray(projectAdmin) || !projectAdmin.every(email => typeof email === 'string'))) {
      return res.status(400).json({
        success: false,
        error: 'Emails should array of email strings'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(requesterEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    console.log('Send feedback received:', {
      message: message ? 'Message provided' : 'No message',
      requesterEmail,
      projectId,
      projectAdmin: projectAdmin || [],
      timestamp: new Date().toISOString()
    });

    // Send feedback email
    console.log('About to send feedback email...');
    const emailResult = await sendFeedbackEmail(
      message || '',
      requesterEmail,
      projectId,
      projectAdmin || [] // Pass projectAdmin emails
    );

    console.log('Email result:', emailResult);

    if (emailResult.success) {
      // Log successful access request
      console.log('Access request processed successfully:', {
        requesterEmail,
        projectId,
        projectAdmin: projectAdmin || [],
        messageId: emailResult.messageId,
        timestamp: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        message: 'Feedback submitted successfully',
        data: {
          requesterEmail,
          projectId,
          projectAdmin: projectAdmin || [],
          messageId: emailResult.messageId,
          submittedAt: new Date().toISOString()
        }
      });
    } else {
      console.error('Failed to send feedback email:', emailResult.error);
      const errorResponse = {
        success: false,
        error: 'Failed to feedback email',
        details: emailResult.error
      };
      console.log('Error response:', errorResponse);
      return res.status(500).json(errorResponse);
    }

  } catch (error) {
    console.error('Error processing access request:', error);
    console.log('Sending 500 error response from catch block...');
    const errorResponse = {
      success: false,
      error: 'Internal server error',
      message: 'Failed to process access request',
      details: error.message
    };
    console.log('Catch block error response:', errorResponse);
    return res.status(500).json(errorResponse);
  }
});

app.get('/api/v1/get-projects', async (req, res) => {
  try {
    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';

    console.log(`[GET-PROJECTS] Using Project: ${projectId}, Location: ${location}`);

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const resourceManagerClientv1 = new ProjectsClient({
      auth: auth,
    });

    if (!projectId) {
      console.error('[GET-PROJECTS] No project ID configured');
      // Return empty array instead of error to prevent UI crash
      return res.json([]);
    }

    let projects = [];
    try {
      const [projectList] = await resourceManagerClientv1.searchProjects();
      projects = projectList || [];
    } catch (err) {
      console.error('[GET-PROJECTS] Error listing projects:', err.message);
      // Return empty array instead of crashing
      return res.json([]);
    }
    res.json(projects.map(({ projectId, name, displayName }) => ({ projectId, name, displayName })));

  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(401).json({ message: 'An error occurred while generating app configs.', details: error.message });
  }
});

/**
 * GET /api/data-scans
 * A protected endpoint to list all data quality scans in the configured location.
 */
app.get('/api/v1/data-scans', async (req, res) => {
  const { project } = req.query;
  try {
    const projectId = (project != '' && project != null && project != "undefined") ? project : (PROJECT_ID);
    const location = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId || !location) {
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID and GCP_LOCATION must be set in the .env file.' });
    }

    const parent = `projects/${projectId}/locations/-`;
    console.log(`Listing data scans for parent: ${parent}`);

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    const [scans] = await dataplexDataScanClientv1.listDataScans({ parent });
    res.json(scans);

  } catch (error) {
    console.error('Error listing data quality scans:', error);
    res.status(500).json({ message: 'An error occurred while listing data quality scans.', details: error.message });
  }
});

/**
 * GET /api/data-quality-scan-jobs/:scanId
 * A protected endpoint to list the jobs (runs and results) for a specific data quality scan.
 */
app.get('/api/v1/data-quality-scan-jobs/:scanId', async (req, res) => {
  const { scanId } = req.params;

  if (!scanId) {
    return res.status(400).json({ message: 'Bad Request: A "scanId" URL parameter is required.' });
  }

  try {
    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';

    if (!projectId || !location) {
      return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID and GCP_LOCATION must be set in the .env file.' });
    }

    const parent = `projects/${projectId}/locations/${location}/dataScans/${scanId}`;
    console.log(`Listing data quality scan jobs for parent: ${parent}`);

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    // The listDataScanJobs method returns recent jobs. The result of each job contains the quality metrics.
    const [jobs] = await dataplexDataScanClientv1.listDataScanJobs({ parent });
    res.json(jobs);

  } catch (error) {
    console.error(`Error listing data quality scan jobs for scan ${scanId}:`, error);
    res.status(500).json({ message: 'An error occurred while listing data quality scan jobs.', details: error.message });
  }
});

/**
 * POST /api/entry-data-quality
 * A protected endpoint to fetch data quality scan results for a specific Dataplex entry.
 */
app.post('/api/v1/entry-data-quality', async (req, res) => {
  const { name, resourceName, parent } = req.body;

  if (!name) {
    return res.status(400).json({ message: 'Bad Request: An "resourceName" field is required.' });
  }

  try {
    // const projectId = PROJECT_ID;
    // const location = process.env.GCP_LOCATION;

    // if (!projectId || !location) {
    //     return res.status(500).json({ message: 'Server Configuration Error: GOOGLE_CLOUD_PROJECT_ID and GCP_LOCATION must be set.' });
    // }

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    //const parent = `projects/${projectId}/locations/${location}`;
    console.log(`Listing all data quality scans in ${parent} to find a match.`);
    const [scans] = await dataplexDataScanClientv1.listDataScans({ parent });
    //console.log(`Data quality scans`, scans);

    const matchingScan = scans.filter(scan => (scan.data.resource === name && scan.type === 'DATA_QUALITY'));
    //console.log(`Data quality scan matching resource: ${resourceName}`, matchingScan);

    // if (!matchingScan) {
    //     return res.status(200).json({ message: `No data quality scan found for resource: ${resourceName}` });
    // }
    const scanIds = matchingScan.map(scan => scan.name);
    //console.log(`Fetching jobs for ${scanIds.length} matching data quality scans.`, scanIds);
    const promises = scanIds.map(scanId => {
      const parent = scanId;
      return dataplexDataScanClientv1.listDataScanJobs({ parent });
    });

    const results = await Promise.all(promises);

    const jobsResponse = results.map(([jobs], index) => ({
      scanId: scanIds[index],
      jobs: jobs,
    }));
    // const jobIds = results.map(job => job.scanId);
    res.json({ "scans": scans, "matchingScan": matchingScan, "jobs": jobsResponse });

  } catch (error) {
    console.error(`Error fetching data quality for entry ${resourceName}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching data quality for the entry.', details: error.message });
  }
});

/**
 * POST /api/get-data-scan
 * A protected endpoint to fetch data quality scan results for a specific Dataplex entry.
 */
app.get('/api/v1/get-data-scan', async (req, res) => {
  const { name } = req.query;

  if (!name) {
    return res.status(400).json({ message: 'Bad Request: An "name" field is required.' });
  }

  try {

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    const getScan = dataplexDataScanClientv1.getDataScan({ name: name, view: 'FULL' });
    const listjobs = dataplexDataScanClientv1.listDataScanJobs({ parent: name });
    const [scan, jobs] = await Promise.all([getScan, listjobs]);
    const jobLists = jobs[0];
    const jobNames = jobLists.map(job => job.name);
    //console.log(`Fetching jobs for ${scanIds.length} matching data quality scans.`, scanIds);
    const promises = jobNames.map(jobName => {
      return dataplexDataScanClientv1.getDataScanJob({ name: jobName, view: 'FULL' });
    });

    const results = await Promise.all(promises);

    const jobsResponse = results.map(([jobs], index) => (jobs));
    res.json({ "scan": scan[0], "jobs": jobsResponse });

  } catch (error) {
    console.error(`Error fetching data scan for scan ${name}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching data scan for scan ${name}.', details: error.message });
  }
});

/**
 * POST /api/get-data-scan
 * A protected endpoint to fetch data quality scan results for a specific Dataplex entry.
 */
app.post('/api/v1/get-jobs-scan', async (req, res) => {
  const { jobs } = req.body;

  if (!jobs) {
    return res.status(400).json({ message: 'Bad Request: An "name" field is required.' });
  }

  try {

    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    const getScan = dataplexDataScanClientv1.getDataScan({ name: name, view: 'FULL' });
    const listjobs = dataplexDataScanClientv1.listDataScanJobs({ parent: name });
    const [scan, jobs] = await Promise.all([getScan, listjobs]);
    res.json({ "scan": scan[0], "jobs": jobs[0] });

  } catch (error) {
    console.error(`Error fetching data scan for scan ${name}:`, error);
    res.status(500).json({ message: 'An error occurred while fetching data scan for scan ${name}.', details: error.message });
  }
});


/**
 * POST /api/batch-data-quality-scan-jobs
 * A protected endpoint to fetch jobs for a list of data quality scan IDs.
 */
app.post('/api/batch-data-quality-scan-jobs', async (req, res) => {
  const { scanIds } = req.body;

  if (!scanIds || !Array.isArray(scanIds)) {
    return res.status(400).json({ message: 'Bad Request: A "scanIds" field (array of strings) is required.' });
  }

  if (scanIds.length === 0) {
    return res.json([]);
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexDataScanClientv1 = new DataScanServiceClient({
      auth: auth,
    });

    console.log(`Fetching jobs for a batch of ${scanIds.length} data quality scans.`);

    const promises = scanIds.map(scanId => {
      const parent = `projects/${PROJECT_ID}/locations/${process.env.GCP_LOCATION || 'us-central1'}/dataScans/${scanId}`;
      return dataplexDataScanClientv1.listDataScanJobs({ parent });
    });

    const results = await Promise.all(promises);

    const jobsResponse = results.map(([jobs], index) => ({
      scanId: scanIds[index],
      jobs: jobs,
    }));

    res.json(jobsResponse);

  } catch (error) {
    console.error('Error fetching data quality scan jobs for batch:', error);
    res.status(500).json({ message: 'An error occurred while fetching data quality scan jobs for the batch.', details: error.message });
  }
});

app.post('/api/v1/get-dataset-entries', async (req, res) => {
  const { parent } = req.body;

  if (!parent) {
    return res.status(400).json({ message: 'Bad Request: An "parent" field is required.' });
  }

  try {
    // ADC Auth
    const auth = new AdcGoogleAuth();

    const dataplexCatalogClientv1 = new CatalogServiceClient({
      auth: auth,
    });

    //const parent = `projects/${projectId}/locations/${location}/entryGroups/${entryGroupId}`;
    console.log(`Listing entries for parent: ${parent}`);
    let request = req.body.filter ? {
      parent: parent,
      filter: req.body.filter
    } : {
      parent: parent
    }

    const [entries] = await dataplexCatalogClientv1.getEntryGroup({ name: parent });
    res.json(entries);

  } catch (error) {
    console.error(`Error listing entries for parent ${parent}:`, error);
    res.status(500).json({ message: 'An error occurred while listing entries.', details: error.message });
  }
});



/**
 * POST /api/v1/search
 * Proxy Dataplex Search with Permission Filtering
 */

// Helper: Check actual admin status using resolved logic
const checkUserAdminRole = async (userEmail) => {
  const role = await adminService.resolveAdminRole(userEmail);
  return !!role;
};

/**
 * POST /api/v1/search
 * Proxy Dataplex Search with Permission Annotation
 */
app.post('/api/v1/search', async (req, res) => {
  try {
    const { query, pageSize, pageToken } = req.body;
    const userEmail = req.headers['x-user-email'];

    console.log('======== [SEARCH START] ========');
    console.log(`[SEARCH] Query: ${query}, User: ${userEmail}`);

    // Check Admin Status (Real IAM Check)
    const isAdmin = await checkUserAdminRole(userEmail);
    console.log(`[SEARCH] Is Admin (User/IAM)? ${isAdmin}`);

    // Fetch ALL results (Service Account Scope)
    const client = new CatalogServiceClient();
    const projectId = PROJECT_ID;
    const location = 'global';

    if (!projectId) {
      console.error('[SEARCH] CRITICAL: No project ID found in environment variables!');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: GOOGLE_CLOUD_PROJECT_ID is not set.',
        data: [],
        results: []
      });
    }

    console.log(`[SEARCH] Using Project: ${projectId}, Location: ${location}`);

    const request = {
      name: `projects/${projectId}/locations/${location}`,
      query: query || '*',
      pageSize: pageSize || 20,
      pageToken: pageToken
    };

    const [searchResults, searchRequest, searchResponse] = await client.searchEntries(request);
    console.log(`[SEARCH] Fetched ${searchResults ? searchResults.length : 0} results from Data Catalog`);


    // Helper for data normalization (used in all access paths) - as requested
    const normalizeEntry = (entry, hasAccess) => {
      // Dataplex results are often nested in 'dataplexEntry' or 'entry'
      const coreEntry = entry.dataplexEntry || entry;
      const source = coreEntry.entrySource || {};

      // Calculate a usable display name (Robust fallbacks for "Unknown Asset" issue)
      const nameFromFQN = coreEntry.fullyQualifiedName?.split('.').pop() || coreEntry.fullyQualifiedName?.split(':').pop();
      const nameFromLR = (entry.linkedResource || '').split('/').pop();
      const nameFromRRN = (entry.relativeResourceName || '').split('/').pop();
      const nameFromPath = (coreEntry.name || entry.name || '').split('/').pop();

      const calculatedDisplayName = source.displayName
        || coreEntry.displayName
        || nameFromFQN
        || nameFromLR
        || nameFromRRN
        || nameFromPath
        || 'Unknown Asset';

      const normalized = {
        ...coreEntry, // Keep original fields

        // Pull nested fields to the top level for the frontend
        name: coreEntry.name || entry.name,
        displayName: calculatedDisplayName,
        description: source.description || coreEntry.description || entry.description || 'No description available',
        fullyQualifiedName: coreEntry.fullyQualifiedName || entry.fullyQualifiedName,

        // Ensure entrySource exists and has data (Frontend looks here specifically)
        entrySource: {
          ...source,
          displayName: calculatedDisplayName,
          description: source.description || coreEntry.description || entry.description || '',
          system: source.system || entry.integratedSystem || 'BIGQUERY', // Default to BigQuery if missing
          location: source.location || (entry.linkedResource?.includes('/locations/') ? entry.linkedResource.split('/locations/')[1].split('/')[0] : 'global')
        },

        // Normalize type for icons - handle full resource paths
        entryType: (() => {
          const raw = (coreEntry.entryType || entry.entryType || entry.searchResultType || 'Unknown');
          // 1. Get last segment if it's a path (slashes)
          let display = raw.split('/').pop();
          // 2. Identify common types from strings like 'bigquery-table' or 'BIGQUERY_DATASET'
          const upper = display.toUpperCase();
          if (upper.includes('TABLE')) return 'Table';
          if (upper.includes('DATASET')) return 'Dataset';
          if (upper.includes('BUCKET')) return 'Bucket';
          if (upper.includes('PRODUCT')) return 'Product';
          if (upper.includes('VIEW')) return 'View';
          if (upper.includes('ROUTINE')) return 'Routine';
          if (upper.includes('MODEL')) return 'Model';

          // 3. Fallback: split by _ or - and get last part
          display = display.split(/[_-]/).pop();
          return display.charAt(0).toUpperCase() + display.slice(1).toLowerCase();
        })(),

        // Helper for the location pill
        location: source.location || (coreEntry.name || entry.name || '').split('/locations/')[1]?.split('/')[0] || 'global',

        // Metadata for sorting/date
        modifyTime: entry.modifyTime || coreEntry.modifyTime,
        updateTime: entry.updateTime || coreEntry.updateTime || entry.modifyTime || coreEntry.modifyTime
      };

      return {
        ...normalized,
        dataplexEntry: normalized,
        userHasAccess: hasAccess
      };
    };

    // --- ACCESS ANNOTATION ---
    // For admins: everything is accessible.
    // For regular users: check actual BigQuery IAM roles on the dataset/table.
    //   1. Check project-level roles first (one API call).
    //   2. If no project-level access, check per-dataset IAM (one call per unique dataset).
    let annotatedResults;

    if (isAdmin) {
      annotatedResults = (searchResults || []).map(entry => normalizeEntry(entry, true));
    } else if (!userEmail) {
      annotatedResults = (searchResults || []).map(entry => normalizeEntry(entry, false));
    } else {
      // Step 1: Check project-level BigQuery roles
      let hasProjectAccess = false;
      try {
        const resourceManager = new ProjectsClient();
        const [policy] = await resourceManager.getIamPolicy({ resource: `projects/${projectId}` });
        const userMember = `user:${userEmail}`;
        const accessRoles = [
          'roles/owner', 'roles/editor', 'roles/viewer',
          'roles/bigquery.dataViewer', 'roles/bigquery.metadataViewer',
          'roles/bigquery.dataEditor', 'roles/bigquery.dataOwner', 'roles/bigquery.admin'
        ];
        hasProjectAccess = policy.bindings?.some(binding =>
          accessRoles.includes(binding.role) && binding.members?.includes(userMember)
        ) || false;
        console.log(`[SEARCH] User ${userEmail} has project-level BQ access? ${hasProjectAccess}`);
      } catch (iamErr) {
        console.warn('[SEARCH] Project IAM check failed:', iamErr.message);
      }

      if (hasProjectAccess) {
        // User has project-level access → all results are accessible
        annotatedResults = (searchResults || []).map(entry => normalizeEntry(entry, true));
      } else {
        // Step 2: Extract unique datasets from results and check IAM per dataset
        const datasetAccessCache = new Map(); // key: "project.dataset" → boolean

        // Parse FQN to get project+dataset
        const parseDataset = (entry) => {
          const fqn = entry.dataplexEntry?.fullyQualifiedName || entry.fullyQualifiedName || '';
          // Format: bigquery:{project}.{dataset}.{table}
          const cleanFqn = fqn.replace('bigquery:', '');
          const parts = cleanFqn.split('.');
          if (parts.length >= 2) {
            return { project: parts[0], dataset: parts[1], key: `${parts[0]}.${parts[1]}` };
          }
          // Try linkedResource format: //bigquery.googleapis.com/projects/{p}/datasets/{d}/...
          const linked = entry.dataplexEntry?.entrySource?.resource || '';
          const bqMatch = linked.match(/projects\/([^/]+)\/datasets\/([^/]+)/);
          if (bqMatch) {
            return { project: bqMatch[1], dataset: bqMatch[2], key: `${bqMatch[1]}.${bqMatch[2]}` };
          }
          return null;
        };

        // Collect unique datasets
        const uniqueDatasets = new Map();
        (searchResults || []).forEach(entry => {
          const ds = parseDataset(entry);
          if (ds && !uniqueDatasets.has(ds.key)) {
            uniqueDatasets.set(ds.key, ds);
          }
        });

        // Check IAM for each unique dataset (parallel, with error handling)
        const datasetChecks = Array.from(uniqueDatasets.values()).map(async (ds) => {
          try {
            const bq = new BigQuery({ projectId: ds.project });
            const dataset = bq.dataset(ds.dataset);
            const [metadata] = await dataset.getMetadata();
            const accessList = metadata.access || [];
            // Log all userByEmail entries for debugging
            const userEntries = accessList.filter(e => e.userByEmail).map(e => `${e.role}:${e.userByEmail}`);
            console.log(`[SEARCH] Dataset ${ds.key} userByEmail entries:`, userEntries);
            // Only check for direct user access in Step 2.
            // Broad project-level roles (like projectReaders) were already checked in Step 1.
            const hasAccess = accessList.some(entry =>
              entry.userByEmail?.toLowerCase() === userEmail.toLowerCase()
            );
            datasetAccessCache.set(ds.key, hasAccess);
          } catch (dsErr) {
            // If we can't check, assume no access
            console.warn(`[SEARCH] Dataset IAM check failed for ${ds.key}: ${dsErr.message}`);
            datasetAccessCache.set(ds.key, false);
          }
        });

        await Promise.all(datasetChecks);
        console.log(`[SEARCH] Checked ${uniqueDatasets.size} datasets, access map:`, Object.fromEntries(datasetAccessCache));

        // Annotate each result based on BigQuery IAM only (single source of truth)
        annotatedResults = (searchResults || []).map(entry => {
          const ds = parseDataset(entry);
          const hasAccess = ds ? (datasetAccessCache.get(ds.key) || false) : false;
          return normalizeEntry(entry, hasAccess);
        });
      }
    }

    // Filter out any null/undefined entries
    const safeResults = (annotatedResults || []).filter(r => r && r.dataplexEntry);

    // Return response
    res.json({
      success: true,
      data: safeResults,
      results: safeResults,
      nextPageToken: searchResponse?.nextPageToken || '',
      totalSize: searchResponse?.totalSize || safeResults.length
    });

  } catch (error) {
    console.error('[SEARCH] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Search failed',
      error: error.message
    });
  }
});


/**
 * GET /api/v1/accessible-tables
 * Returns all tables/views the user has access to, grouped by dataset.
 * Reuses the same IAM-checking logic as /search.
 */
/**
 * GET /api/v1/accessible-tables
 * Returns all tables/views the user has access to, grouped by dataset.
 * Reuses the same IAM-checking logic as /search but iterates through ALL configured projects.
 */
app.get('/api/v1/accessible-tables', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];
    console.log('======== [ACCESSIBLE-TABLES START] ========');
    console.log(`[ACCESSIBLE-TABLES] User: ${userEmail}`);

    const isAdmin = await checkUserAdminRole(userEmail); // Check if user is a Dataplex Admin

    // 1. Fetch all configured projects (mirroring app-configs logic)
    const resourceManagerClient = new ProjectsClient();
    let projects = [];
    try {
      const [projectList] = await resourceManagerClient.searchProjects({ pageSize: 2000 }, { autoPaginate: false });
      // Ensure current PROJECT_ID is included if not in search results
      const currentExists = projectList.find(p => p.projectId === PROJECT_ID);
      projects = currentExists ? projectList : [...projectList, { projectId: PROJECT_ID }];
    } catch (err) {
      console.warn('[ACCESSIBLE-TABLES] Failed to list projects, falling back to current project:', err.message);
      projects = [{ projectId: PROJECT_ID }];
    }

    console.log(`[ACCESSIBLE-TABLES] Searching across ${projects.length} projects: ${projects.map(p => p.projectId).join(', ')}`);

    // 2. Search for TABLE and VIEW entries in EACH project
    const client = new CatalogServiceClient();
    let allResults = [];
    const location = 'global';

    // Helper to search a single project
    const searchProjectEntries = async (projId) => {
      let projResults = [];
      let pageToken = undefined;
      try {
        do {
          const request = {
            name: `projects/${projId}/locations/${location}`,
            query: 'type=TABLE OR type=VIEW',
            pageSize: 100,
            pageToken: pageToken
          };
          const [results, , response] = await client.searchEntries(request);
          if (results && results.length > 0) {
            projResults = projResults.concat(results);
          }
          pageToken = response?.nextPageToken || null;
        } while (pageToken && projResults.length < 500); // Cap per project
      } catch (err) {
        // Ignore project permission errors (e.g. if service account can't list entries in that project)
        // console.warn(`[ACCESSIBLE-TABLES] Warning: Could not search project ${projId}: ${err.message}`);
      }
      return projResults;
    };

    // Run searches in parallel (with some concurrency control if needed, but Promise.all is okay for < 20 projects)
    const projectSearchPromises = projects.map(p => searchProjectEntries(p.projectId));
    const searchResultsArrays = await Promise.all(projectSearchPromises);
    allResults = searchResultsArrays.flat();

    console.log(`[ACCESSIBLE-TABLES] Fetched ${allResults.length} total table/view entries across all projects`);

    // --- ACCESS ANNOTATION ---
    const normalizeTableEntry = (entry, hasAccess) => {
      const coreEntry = entry.dataplexEntry || entry;
      const source = coreEntry.entrySource || {};
      const nameFromFQN = coreEntry.fullyQualifiedName?.split('.').pop();
      const nameFromPath = (coreEntry.name || entry.name || '').split('/').pop();
      const displayName = source.displayName || coreEntry.displayName || nameFromFQN || nameFromPath || 'Unknown';
      const fqn = coreEntry.fullyQualifiedName || '';
      const cleanFqn = fqn.replace('bigquery:', '');
      const parts = cleanFqn.split('.');
      const dataset = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : 'unknown';

      const rawType = coreEntry.entryType || entry.entryType || '';
      const upper = (typeof rawType === 'string' ? rawType : '').toUpperCase();
      let entryType = 'Table';
      if (upper.includes('VIEW')) entryType = 'View';

      return {
        name: coreEntry.name || entry.name,
        displayName,
        fullyQualifiedName: fqn,
        entryType,
        description: source.description || coreEntry.description || '',
        dataset, // Format: project.dataset
        userHasAccess: hasAccess,
        entrySource: {
          displayName,
          description: source.description || coreEntry.description || '',
          system: source.system || 'BIGQUERY'
        }
      };
    };

    let accessibleTables = [];

    if (isAdmin) {
      accessibleTables = allResults.map(e => normalizeTableEntry(e, true));
    } else if (!userEmail) {
      // If no email, returning empty list (or could return 400, but empty is safer for UI)
      accessibleTables = [];
    } else {
      // Collect unique projects and datasets to check access
      const uniqueProjects = new Set();
      const uniqueDatasets = new Map(); // key: "project.dataset" -> { project, dataset }

      const parseDataset = (entry) => {
        const fqn = (entry.dataplexEntry || entry).fullyQualifiedName || '';
        const parts = fqn.replace('bigquery:', '').split('.');
        if (parts.length >= 2) return { project: parts[0], dataset: parts[1], key: `${parts[0]}.${parts[1]}` };
        return null;
      };

      allResults.forEach(entry => {
        const ds = parseDataset(entry);
        if (ds) {
          uniqueProjects.add(ds.project);
          if (!uniqueDatasets.has(ds.key)) uniqueDatasets.set(ds.key, ds);
        }
      });

      // 1. Check Project-Level Access (Bulk Check)
      const projectAccessMap = new Map(); // projectId -> boolean
      const resourceManager = new ProjectsClient();
      const accessRoles = [
        'roles/owner', 'roles/editor', 'roles/viewer',
        'roles/bigquery.dataViewer', 'roles/bigquery.metadataViewer',
        'roles/bigquery.dataEditor', 'roles/bigquery.dataOwner', 'roles/bigquery.admin'
      ];
      const userMember = `user:${userEmail}`;

      await Promise.all(Array.from(uniqueProjects).map(async (pId) => {
        try {
          const [policy] = await resourceManager.getIamPolicy({ resource: `projects/${pId}` });
          const hasProjectAccess = policy.bindings?.some(binding =>
            accessRoles.includes(binding.role) && binding.members?.includes(userMember)
          ) || false;
          projectAccessMap.set(pId, hasProjectAccess);
        } catch (err) {
          // console.warn(`[ACCESSIBLE-TABLES] Project IAM check failed for ${pId}:`, err.message);
          projectAccessMap.set(pId, false);
        }
      }));

      // 2. Check Dataset-Level Access (for projects where user lacks project-level access)
      const datasetAccessCache = new Map(); // dsKey -> boolean

      await Promise.all(Array.from(uniqueDatasets.values()).map(async (ds) => {
        // If user has project access, they have dataset access
        if (projectAccessMap.get(ds.project)) {
          datasetAccessCache.set(ds.key, true);
          return;
        }

        // Otherwise, check specific dataset IAM
        try {
          const bq = new BigQuery({ projectId: ds.project });
          const dataset = bq.dataset(ds.dataset);
          const [metadata] = await dataset.getMetadata();
          const hasAccess = (metadata.access || []).some(entry =>
            entry.userByEmail?.toLowerCase() === userEmail.toLowerCase()
          );
          datasetAccessCache.set(ds.key, hasAccess);
        } catch (dsErr) {
          datasetAccessCache.set(ds.key, false);
        }
      }));

      // Filter and Normalize
      accessibleTables = allResults
        .map(entry => {
          const ds = parseDataset(entry);
          const hasAccess = ds ? (datasetAccessCache.get(ds.key) || false) : false;
          return normalizeTableEntry(entry, hasAccess);
        })
        .filter(t => t.userHasAccess);
    }

    // Filter to only accessible and group by dataset
    const tables = (accessibleTables || []).filter(t => t.userHasAccess);
    const groupedByDataset = {};
    tables.forEach(t => {
      if (!groupedByDataset[t.dataset]) groupedByDataset[t.dataset] = [];
      groupedByDataset[t.dataset].push(t);
    });

    console.log(`[ACCESSIBLE-TABLES] Returning ${tables.length} accessible tables across ${Object.keys(groupedByDataset).length} datasets`);
    res.json({ tables, groupedByDataset });

  } catch (error) {
    console.error('[ACCESSIBLE-TABLES] Error:', error);
    res.status(500).json({ error: 'Failed to fetch accessible tables', message: error.message });
  }
});


/**
 * GET /api/v1/lineage
 * Retrieves data lineage (relationships) for a given FQN.
 * Performs a Breadth-First Search (BFS) to find upstream/downstream up to a specific depth.
 */
app.get('/api/v1/lineage', async (req, res) => {
  try {
    const { fqn, depth = 3 } = req.query;
    const maxDepth = Math.min(parseInt(depth), 6); // Cap at 6 as requested

    if (!fqn) {
      return res.status(400).json({ error: 'FQN is required' });
    }

    const projectId = PROJECT_ID;
    const location = process.env.GCP_LOCATION || 'us-central1';

    // Helper: Convert Dataplex FQN to Lineage Entity ID
    // Input: strings like "bigquery:proj.ds.tbl" or "proj.ds.tbl"
    // Output: "//bigquery.googleapis.com/projects/proj/datasets/ds/tables/tbl"
    const convertToLineageEntity = (rawFqn) => {
      let clean = rawFqn.replace('bigquery:', '').replace('bigquery://', '');
      const parts = clean.split('.');
      if (parts.length === 3) {
        return `//bigquery.googleapis.com/projects/${parts[0]}/datasets/${parts[1]}/tables/${parts[2]}`;
      }
      return null;
    };

    // Helper: Convert Lineage Entity ID back to short name
    const convertToShortName = (entityId) => {
      if (entityId.includes('tables/')) {
        return entityId.split('tables/')[1];
      }
      return entityId.split('/').pop();
    };

    const rootEntity = convertToLineageEntity(fqn);
    if (!rootEntity) {
      return res.json({ relationships: [] }); // Invalid format, return empty
    }

    const lineageClient = new LineageClient(); // ADC

    // BFS Structures
    let relationships = [];
    let visited = new Set();
    let queue = [{ entity: rootEntity, currentDepth: 0 }];
    visited.add(rootEntity);

    // BFS Loop
    while (queue.length > 0) {
      const { entity, currentDepth } = queue.shift();

      if (currentDepth >= maxDepth) continue;

      try {
        // Search Links (Both Upstream and Downstream)
        const parent = `projects/${projectId}/locations/${location}`;
        const request = {
          parent: parent,
          target: { fullyQualifiedName: entity },
          pageSize: 50 // Limit per node
        };

        const [links] = await lineageClient.searchLinks(request);

        for (const link of links) {
          const source = link.source.fullyQualifiedName;
          const target = link.target.fullyQualifiedName;

          // Determine relationship direction relative to current node
          // If current is source, then target is downstream
          // If current is target, then source is upstream
          let relType = 'Unknown';
          let otherNode = '';

          if (source === entity) {
            relType = 'Downstream';
            otherNode = target;
          } else {
            relType = 'Upstream';
            otherNode = source;
          }

          // Add to result
          relationships.push({
            table1: convertToShortName(source),
            table2: convertToShortName(target),
            relationship: 'Flows To' // Directed edge
          });

          // Enqueue neighbor if not visited
          if (!visited.has(otherNode)) {
            visited.add(otherNode);
            queue.push({ entity: otherNode, currentDepth: currentDepth + 1 });
          }
        }
      } catch (err) {
        console.warn(`[LINEAGE] Error searching links for ${entity}:`, err.message);
        // Continue BFS even if one node fails
      }
    }

    // Deduplicate relationships
    const uniqueRels = [];
    const relSet = new Set();
    relationships.forEach(r => {
      const key = `${r.table1}->${r.table2}`;
      if (!relSet.has(key)) {
        relSet.add(key);
        uniqueRels.push(r);
      }
    });

    res.json({ relationships: uniqueRels });

  } catch (error) {
    console.error('[LINEAGE] API Error:', error);
    res.status(500).json({ error: 'Failed to fetch lineage', details: error.message });
  }
});


/**
 * GET /api/v1/dataset-relationships
 * Get inferred relationships between tables in a dataset.
 * Uses schema analysis to detect FK-like columns and caches results in Firestore.
 *
 * Query params:
 * - project: GCP project ID (required)
 * - dataset: BigQuery dataset ID (required)
 * - refresh: Set to 'true' to force cache refresh
 */
app.get('/api/v1/dataset-relationships', async (req, res) => {
  try {
    const { project, dataset, refresh } = req.query;

    if (!project || !dataset) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['project', 'dataset']
      });
    }

    console.log(`[RELATIONSHIPS] Fetching relationships for ${project}.${dataset}`);

    // Check cache first (unless refresh requested)
    if (refresh !== 'true') {
      const cached = await datasetRelationshipService.getCachedRelationships(project, dataset);
      if (cached && cached.length > 0) {
        return res.json({
          relationships: cached,
          source: 'cache',
          project,
          dataset
        });
      }
    }

    // Fetch all tables in the dataset using Data Catalog search
    console.log(`[RELATIONSHIPS] Cache miss, fetching tables from Data Catalog...`);

    // Use DataCatalogClient for searchCatalog, BigQuery for schemas
    const dataCatalogClient = new DataCatalogClient();
    const bigquery = new BigQuery({ projectId: project });

    // Search for all tables in this dataset
    const searchQuery = `system=bigquery type=TABLE parent:${project}.${dataset}`;

    const [searchResults] = await dataCatalogClient.searchCatalog({
      scope: {
        includeProjectIds: [project, PROJECT_ID],
        includeGcpPublicDatasets: false
      },
      query: searchQuery,
      pageSize: 100
    });

    console.log(`[RELATIONSHIPS] Found ${searchResults.length} tables in ${project}.${dataset}`);

    if (!searchResults || searchResults.length === 0) {
      return res.json({
        relationships: [],
        source: 'inferred',
        message: 'No tables found in dataset',
        project,
        dataset
      });
    }

    // Fetch schema for each table using BigQuery directly
    const tables = [];
    for (const result of searchResults) {
      try {
        // Extract table name from FQN like "bigquery:project.dataset.table"
        const fqn = result.fullyQualifiedName || '';
        const tableName = fqn.split('.').pop() || result.displayName || 'unknown';

        // Get table schema from BigQuery
        const [metadata] = await bigquery.dataset(dataset).table(tableName).getMetadata();
        const schema = (metadata.schema?.fields || []).map(f => ({
          name: f.name,
          type: f.type
        }));

        tables.push({
          name: tableName,
          fullyQualifiedName: fqn,
          schema
        });
      } catch (entryErr) {
        console.warn(`[RELATIONSHIPS] Failed to get schema for table ${result.fullyQualifiedName}:`, entryErr.message);
      }
    }

    console.log(`[RELATIONSHIPS] Got schemas for ${tables.length} tables`);

    // Infer relationships from schemas
    const relationships = datasetRelationshipService.inferRelationships(tables);

    console.log(`[RELATIONSHIPS] Inferred ${relationships.length} relationships`);

    // Cache the results
    await datasetRelationshipService.cacheRelationships(project, dataset, relationships, tables);

    res.json({
      relationships,
      source: 'inferred',
      tableCount: tables.length,
      project,
      dataset
    });

  } catch (error) {
    console.error('[RELATIONSHIPS] Error:', error);
    res.status(500).json({
      error: 'Failed to fetch dataset relationships',
      details: error.message
    });
  }
});


/**
 * POST /api/v1/dataset-relationships/manual
 * Add a manual relationship between tables
 */
app.post('/api/v1/dataset-relationships/manual', async (req, res) => {
  try {
    const { project, dataset, table1, table2, relationship } = req.body;

    if (!project || !dataset || !table1 || !table2) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['project', 'dataset', 'table1', 'table2']
      });
    }

    const newRelationship = {
      table1,
      table2,
      relationship: relationship || 'Related To'
    };

    const relationships = await datasetRelationshipService.addManualRelationship(
      project,
      dataset,
      newRelationship
    );

    res.json({
      success: true,
      relationships,
      added: newRelationship
    });

  } catch (error) {
    console.error('[RELATIONSHIPS] Manual add error:', error);
    res.status(500).json({ error: 'Failed to add relationship', details: error.message });
  }
});


/**
 * DELETE /api/v1/dataset-relationships/cache
 * Invalidate the relationship cache for a dataset
 */
app.delete('/api/v1/dataset-relationships/cache', async (req, res) => {
  try {
    const { project, dataset } = req.query;

    if (!project || !dataset) {
      return res.status(400).json({ error: 'Missing project or dataset' });
    }

    await datasetRelationshipService.invalidateCache(project, dataset);
    res.json({ success: true, message: `Cache invalidated for ${project}.${dataset}` });

  } catch (error) {
    console.error('[RELATIONSHIPS] Cache invalidate error:', error);
    res.status(500).json({ error: 'Failed to invalidate cache', details: error.message });
  }
});


/**
 * POST /api/v1/check-access
 * Check if a user has access to a specific BigQuery table/dataset
 */
app.post('/api/v1/check-access', async (req, res) => {
  try {
    const { fullyQualifiedName, linkedResource } = req.body;
    const userEmail = req.headers['x-user-email'];

    if (!userEmail) {
      return res.status(400).json({ hasAccess: false, error: 'User email required' });
    }

    // SUPER_ADMIN bypass - they have access to everything
    const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
    // Fix: Use 'includes'
    if (SUPER_ADMIN_EMAIL && userEmail.toLowerCase().includes(SUPER_ADMIN_EMAIL.toLowerCase())) {
      console.log(`MATCHED ADMIN: [${userEmail}] matches [${SUPER_ADMIN_EMAIL}] - granting full access`);
      return res.json({ hasAccess: true, level: 'super_admin' });
    }

    // Extract project/dataset from fullyQualifiedName or linkedResource
    // FQN format: bigquery:{project}.{dataset}.{table}
    // LinkedResource format: //bigquery.googleapis.com/projects/{project}/datasets/{dataset}/tables/{table}
    let targetProject = null;
    let datasetId = null;

    if (fullyQualifiedName) {
      const fqn = fullyQualifiedName.replace('bigquery:', '');
      const parts = fqn.split('.');
      if (parts.length >= 2) {
        targetProject = parts[0];
        datasetId = parts[1];
      }
    } else if (linkedResource && linkedResource.startsWith('//bigquery.googleapis.com/')) {
      const parts = linkedResource.split('/');
      const projectIndex = parts.indexOf('projects');
      const datasetIndex = parts.indexOf('datasets');
      if (projectIndex !== -1) targetProject = parts[projectIndex + 1];
      if (datasetIndex !== -1) datasetId = parts[datasetIndex + 1];
    }

    if (!targetProject) {
      console.log(`[CHECK-ACCESS] Could not extract project from FQN: ${fullyQualifiedName}`);
      return res.json({ hasAccess: false, reason: 'Could not determine project' });
    }

    console.log(`[CHECK-ACCESS] Checking access for ${userEmail} on project ${targetProject}, dataset ${datasetId}`);

    // 1. Check project-level access
    const isOwner = await verifyUserAccess(targetProject, userEmail, 'roles/owner');
    const isEditor = await verifyUserAccess(targetProject, userEmail, 'roles/editor');
    const isViewer = await verifyUserAccess(targetProject, userEmail, 'roles/viewer');
    const isBqViewer = await verifyUserAccess(targetProject, userEmail, 'roles/bigquery.dataViewer');
    const isBqAdmin = await verifyUserAccess(targetProject, userEmail, 'roles/bigquery.admin');

    console.log(`[CHECK-ACCESS] Project roles - Owner:${isOwner}, Editor:${isEditor}, Viewer:${isViewer}, BQ Viewer:${isBqViewer}, BQ Admin:${isBqAdmin}`);

    if (isOwner || isEditor || isViewer || isBqViewer || isBqAdmin) {
      return res.json({ hasAccess: true, level: 'project' });
    }

    // 2. Check dataset-level access
    if (datasetId) {
      try {
        const bq = new BigQuery({ projectId: targetProject });
        const dataset = bq.dataset(datasetId);
        const [policy] = await dataset.getIamPolicy();

        const userMember = `user:${userEmail}`;
        const hasDatasetAccess = policy.bindings?.some(binding => {
          const meaningfulRoles = [
            'roles/bigquery.dataViewer',
            'roles/bigquery.dataEditor',
            'roles/bigquery.dataOwner',
            'roles/bigquery.admin',
            'roles/viewer', 'roles/editor', 'roles/owner'
          ];
          return meaningfulRoles.includes(binding.role) && binding.members?.includes(userMember);
        });

        if (hasDatasetAccess) {
          return res.json({ hasAccess: true, level: 'dataset' });
        }
      } catch (dsError) {
        console.warn(`[CHECK-ACCESS] Dataset IAM check failed: ${dsError.message}`);
      }
    }

    return res.json({ hasAccess: false, reason: 'No matching IAM bindings found' });

  } catch (error) {
    console.error('[CHECK-ACCESS] Error:', error);
    return res.status(500).json({ hasAccess: false, error: error.message });
  }
});

app.post('/api/v1/access-request', async (req, res) => {
  try {
    const { assetName, linkedResource, message, requesterEmail, projectId, projectAdmin, assetType } = req.body;

    // Validation
    if (!assetName || typeof assetName !== 'string' || assetName.trim() === '') {
      console.log('Validation failed: Asset name is missing or invalid');
      return res.status(400).json({
        success: false,
        error: 'Asset name is required and must be a non-empty string'
      });
    }

    if (!requesterEmail || typeof requesterEmail !== 'string' || requesterEmail.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Requester email is required and must be a non-empty string'
      });
    }

    if (!projectId || typeof projectId !== 'string' || projectId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Project ID is required and must be a non-empty string'
      });
    }

    if (projectAdmin && (!Array.isArray(projectAdmin) || !projectAdmin.every(email => typeof email === 'string'))) {
      return res.status(400).json({
        success: false,
        error: 'Project admin must be an array of email strings'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(requesterEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    console.log('Access request received:', {
      assetName,
      linkedResource: linkedResource || 'NOT PROVIDED',
      message: message ? 'Message provided' : 'No message',
      requesterEmail,
      projectId,
      projectAdmin: projectAdmin || [],
      timestamp: new Date().toISOString()
    });

    const accessToken = req.headers.authorization?.split(' ')[1]; // Expect



    // Create access request object
    const requestData = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      assetName,
      assetType: assetType || '',
      linkedResource: linkedResource || '', // Full resource path for IAM provisioning
      message: message || '',
      requesterEmail,
      projectId,
      gcpProjectId: projectId,
      requestedRole: 'roles/bigquery.dataViewer', // Defaulting for now
      projectAdmin: projectAdmin || [],
      status: 'pending',
      autoApproved: false
    };

    // Store the request in Firestore
    console.log('[ACCESS-REQUEST] About to write to Firestore with data:', JSON.stringify(requestData, null, 2));
    let accessRequest;
    try {
      accessRequest = await createAccessRequest(requestData);
      console.log('[ACCESS-REQUEST] Successfully saved to Firestore:', accessRequest.id);
    } catch (firestoreError) {
      console.error('[ACCESS-REQUEST] Firestore write FAILED:', firestoreError);
      return res.status(500).json({
        success: false,
        error: 'Failed to save access request to database',
        details: firestoreError.message
      });
    }

    // Send in-app notifications to project admins
    if (projectAdmin && projectAdmin.length > 0) {
      try {
        await notificationService.notifyNewRequest(accessRequest, projectAdmin);
        console.log(`Sent in-app notifications to ${projectAdmin.length} admin(s)`);
      } catch (notifError) {
        console.error('Failed to send in-app notifications:', notifError);
        // Don't fail the request if notifications fail
      }
    }

    // Send access request email
    console.log('About to send access request email...');
    const emailResult = await sendAccessRequestEmail(
      assetName,
      message || '',
      requesterEmail,
      projectId,
      projectAdmin || [],
      assetType || ''
    );

    console.log('Email result:', emailResult);

    if (!emailResult.success) {
      console.error('Failed to send access request email:', emailResult.error);
      // We don't fail the request if email fails, but we log it.
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Access request submitted successfully',
      data: {
        ...accessRequest,
        messageId: emailResult.success ? 'email_sent' : null
      }
    });

  } catch (error) {
    console.error('Error processing access request:', error);
    console.log('Sending 500 error response from catch block...');
    const errorResponse = {
      success: false,
      error: 'Internal server error',
      message: 'Failed to process access request',
      details: error.message
    };
    console.log('Catch block error response:', errorResponse);
    return res.status(500).json(errorResponse);
  }
});

/**
 * GET /api/v1/access-requests
 * Get all access requests with filtering based on user role
 */
app.get('/api/v1/access-requests', async (req, res) => {
  try {
    const userEmail = req.query.userEmail || req.headers['x-user-email'];
    const userRole = req.query.userRole || req.headers['x-user-role'] || 'user';
    const status = req.query.status;
    const projectId = req.query.projectId;

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email is required' });
    }

    const filters = {};
    if (status) filters.status = status;
    if (projectId) filters.projectId = projectId;

    if (userRole === 'admin') {
      // Fetch all
    } else if (userRole === 'manager') {
      if (projectId) filters.projectId = projectId;
    } else {
      filters.requesterEmail = userEmail;
    }

    let filteredRequests = await getAccessRequests(filters);

    return res.status(200).json({
      success: true,
      data: filteredRequests,
      count: filteredRequests.length
    });

  } catch (error) {
    console.error('Error fetching access requests:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch access requests',
      details: error.message
    });
  }
});

/**
 * POST /api/v1/access-request/update
 * Approve or Reject access requests.
 * On APPROVE: Grants BigQuery dataset READER access, then updates Firestore, then sends email.
 * On REJECT: Updates Firestore, then sends email.
 */
app.post('/api/v1/access-request/update', async (req, res) => {
  try {
    console.log('======== [ACCESS-REQUEST UPDATE] ========');
    console.log('[UPDATE] Body:', JSON.stringify(req.body, null, 2));

    // Flexible Field Parsing (Frontend vs Backend mismatch fix)
    const requestId = req.body.requestId || req.body.id || req.body._id;
    const rawStatus = req.body.status || req.body.newStatus || req.body.action;
    const adminNote = req.body.adminNote || req.body.reason || '';
    const reviewerEmail = req.headers['x-user-email'] || req.body.reviewerEmail || 'system';

    if (!requestId || !rawStatus) {
      console.warn('[UPDATE] Missing requestId or status');
      return res.status(400).json({ success: false, error: 'Missing requestId or status' });
    }

    const status = rawStatus.toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status. Must be APPROVED or REJECTED.' });
    }

    console.log(`[UPDATE] Processing: ID=${requestId}, Status=${status}, Reviewer=${reviewerEmail}`);

    // Fetch the original request to get linkedResource and requesterEmail
    const originalRequest = await getAccessRequestById(requestId);
    if (!originalRequest) {
      return res.status(404).json({ success: false, error: 'Access request not found' });
    }

    // --- IAM PROVISIONING on APPROVE ---
    let iamGranted = false;
    if (status === 'APPROVED') {
      const linkedResource = originalRequest.linkedResource || originalRequest.assetName || req.body.linkedResource || '';
      const requesterEmail = originalRequest.requesterEmail || '';

      if (linkedResource && requesterEmail) {
        // Parse linkedResource to extract project and dataset
        // Formats: //bigquery.googleapis.com/projects/{p}/datasets/{d}/tables/{t}
        //          projects/{p}/datasets/{d}
        //          bigquery:{project}.{dataset}.{table}
        let iamProjectId, datasetId;

        const bqMatch = linkedResource.match(/projects\/([^/]+)\/datasets\/([^/]+)/);
        if (bqMatch && bqMatch.length >= 3) {
          iamProjectId = bqMatch[1];
          datasetId = bqMatch[2];
        } else if (linkedResource.includes('bigquery:') || linkedResource.includes('bigquery://')) {
          const fqn = linkedResource.replace('bigquery://', '').replace('bigquery:', '');
          const parts = fqn.split('.');
          if (parts.length >= 2) {
            iamProjectId = parts[0];
            datasetId = parts[1];
          }
        } else {
          // Fallback for FQNs like //bigquery.googleapis.com/projects/p/datasets/d
          const deepMatch = linkedResource.match(/projects\/([^/]+)\/datasets\/([^/]+)/);
          if (deepMatch) {
            iamProjectId = deepMatch[1];
            datasetId = deepMatch[2];
          }
        }

        if (iamProjectId && datasetId) {
          try {
            console.log(`[UPDATE] Granting BigQuery READER access: user=${requesterEmail}, project=${iamProjectId}, dataset=${datasetId}`);
            const bigqueryClient = new BigQuery({ projectId: iamProjectId });
            const dataset = bigqueryClient.dataset(datasetId);
            const [metadata] = await dataset.getMetadata();
            const accessList = metadata.access || [];

            // Check for duplicates
            const userExists = accessList.some(entry => entry.userByEmail === requesterEmail);
            if (!userExists) {
              accessList.push({ role: 'READER', userByEmail: requesterEmail });
              await dataset.setMetadata({ access: accessList });
              console.log(`[UPDATE] IAM READER access granted to ${requesterEmail} on ${datasetId}`);
            } else {
              console.log(`[UPDATE] User ${requesterEmail} already has access to ${datasetId}`);
            }
            iamGranted = true;

            // Record the granted access in Firestore so the lock icon updates
            try {
              await grantedAccessService.createGrantedAccess({
                userEmail: requesterEmail,
                assetName: linkedResource,
                gcpProjectId: iamProjectId,
                role: 'roles/bigquery.dataViewer',
                grantedBy: reviewerEmail,
                originalRequestId: requestId
              });
              console.log(`[UPDATE] Granted access record created in Firestore for ${requesterEmail}`);
            } catch (grantRecordErr) {
              console.warn('[UPDATE] Failed to create granted access record (non-blocking):', grantRecordErr.message);
            }
          } catch (iamError) {
            console.error('[UPDATE] IAM grant failed:', iamError.message);
            // Still update Firestore but note the IAM failure
            return res.status(500).json({
              success: false,
              error: 'Failed to grant BigQuery access. Request not approved.',
              details: iamError.message
            });
          }
        } else {
          console.warn('[UPDATE] Could not parse linkedResource for IAM grant:', linkedResource);
          // Proceed with DB update even if we can't parse the resource
        }
      }
    }

    // --- UPDATE FIRESTORE ---
    const updatedRequest = await updateAccessRequestStatus(requestId, status, adminNote, reviewerEmail);

    if (!updatedRequest) {
      console.error('[UPDATE] Firestore update returned null.');
      return res.status(404).json({ success: false, error: 'Request not found or failed to update' });
    }

    // --- SEND EMAIL NOTIFICATION (non-blocking) ---
    try {
      const reqEmail = originalRequest.requesterEmail || '';
      const asset = originalRequest.assetName || originalRequest.linkedResource || 'Unknown Asset';

      if (reqEmail) {
        if (status === 'APPROVED') {
          await sendApprovalEmail(asset, reqEmail, PROJECT_ID, adminNote, reviewerEmail);
        } else {
          await sendRejectionEmail(asset, reqEmail, PROJECT_ID, adminNote, reviewerEmail);
        }
      }
    } catch (emailError) {
      console.warn('[UPDATE] Email notification failed (non-blocking):', emailError.message);
    }

    console.log('[UPDATE] Success.');
    return res.json({
      success: true,
      data: updatedRequest,
      iamGranted: iamGranted
    });

  } catch (error) {
    console.error('[UPDATE] Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
  }
});


/**
 * POST /api/v1/access/revoke
 * Revoke a previously granted access.
 * 1. Look up the grant record from Firestore by grantId.
 * 2. Verify the revoker is an admin for the project.
 * 3. Remove BigQuery dataset-level READER access.
 * 4. Update Firestore status to 'REVOKED'.
 */
app.post('/api/v1/access/revoke', async (req, res) => {
  try {
    const { grantId } = req.body;
    const revokerEmail = req.headers['x-user-email'];
    console.log(`[REVOKE] Request for grantId=${grantId} by ${revokerEmail}`);

    if (!grantId) {
      return res.status(400).json({ success: false, error: 'Grant ID is required' });
    }

    // 1. Look up the grant record
    const grant = await grantedAccessService.getGrantedAccessById(grantId);
    if (!grant) {
      return res.status(404).json({ success: false, error: 'Grant not found' });
    }

    if (grant.status === 'REVOKED') {
      return res.status(400).json({ success: false, error: 'Access already revoked' });
    }

    // 2. Check if revoker is admin for this project
    const isAdmin = await adminService.isProjectAdmin(revokerEmail, grant.gcpProjectId);
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Not authorized to revoke access for this project' });
    }

    // 3. Remove from BigQuery dataset-level IAM (matching how we grant)
    let revokeIamStatus = 'NOT_ATTEMPTED';
    const assetName = grant.assetName;
    const userEmail = grant.userEmail;

    if (assetName) {
      let iamProjectId, datasetId;
      const bqMatch = assetName.match(/projects\/([^/]+)\/datasets\/([^/]+)/);
      if (bqMatch) {
        iamProjectId = bqMatch[1];
        datasetId = bqMatch[2];
      } else if (assetName.includes('bigquery:') || assetName.includes('.')) {
        const clean = assetName.replace('bigquery:', '').replace('bigquery://', '');
        const parts = clean.split('.');
        if (parts.length >= 2) { iamProjectId = parts[0]; datasetId = parts[1]; }
      }

      if (iamProjectId && datasetId) {
        try {
          const bq = new BigQuery({ projectId: iamProjectId });
          const dataset = bq.dataset(datasetId);
          const [metadata] = await dataset.getMetadata();
          let accessList = metadata.access || [];

          const initialLength = accessList.length;
          accessList = accessList.filter(a => a.userByEmail?.toLowerCase() !== userEmail.toLowerCase());

          if (accessList.length < initialLength) {
            await dataset.setMetadata({ access: accessList });
            revokeIamStatus = 'SUCCESS';
            console.log(`[REVOKE] IAM access removed for ${userEmail} on ${datasetId}`);
          } else {
            revokeIamStatus = 'NOT_FOUND_IN_IAM';
            console.log(`[REVOKE] User ${userEmail} not found in dataset ${datasetId} IAM`);
          }
        } catch (iamErr) {
          console.warn('[REVOKE] IAM removal failed:', iamErr.message);
          revokeIamStatus = 'FAILED';
        }
      }
    }

    // 4. Update Firestore via grantedAccessService (uses correct 'granted-accesses' collection)
    const revokedGrant = await grantedAccessService.revokeAccess(grantId, revokerEmail);

    // 5. Send notification (non-blocking)
    try {
      await notificationService.notifyAccessRevoked(grant, revokerEmail);
      console.log(`[REVOKE] Notification sent to ${userEmail}`);
    } catch (notifErr) {
      console.warn('[REVOKE] Notification failed:', notifErr.message);
    }

    res.json({ success: true, revokeIamStatus, data: revokedGrant });

  } catch (err) {
    console.error('[REVOKE] Error:', err);
    res.status(500).json({ success: false, error: 'Revocation failed', details: err.message });
  }
});

// ============================================
// ADMIN ROLE MANAGEMENT ENDPOINTS
// ============================================

/**
 * GET /api/v1/admin/check
 * Check if current user is an admin and get their role
 */
app.get('/api/v1/admin/check', async (req, res) => {
  try {
    const userEmail = req.query.email || req.headers['x-user-email'];

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email is required' });
    }

    // Use centralized resolution logic (Firestore -> Env -> IAM)
    const adminRole = await adminService.resolveAdminRole(userEmail);

    return res.status(200).json({
      success: true,
      isAdmin: adminRole !== null,
      role: adminRole
    });
  } catch (error) {
    console.error('Error checking admin status:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/admin/roles
 * List all admin roles (super-admin only)
 */
app.get('/api/v1/admin/roles', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];

    // Check if requester is super-admin
    const isSuperAdmin = await adminService.isSuperAdmin(userEmail);
    if (!isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only super-admins can list all admin roles' });
    }

    const admins = await adminService.getAllAdmins();

    return res.status(200).json({
      success: true,
      data: admins,
      count: admins.length
    });
  } catch (error) {
    console.error('Error listing admin roles:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/admin/roles
 * Create or update an admin role (super-admin only)
 */
app.post('/api/v1/admin/roles', async (req, res) => {
  try {
    const { email, role, assignedProjects } = req.body;
    const creatorEmail = req.headers['x-user-email'];

    if (!email || !role) {
      return res.status(400).json({ success: false, error: 'Email and role are required' });
    }

    if (!['super-admin', 'project-admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Role must be "super-admin" or "project-admin"' });
    }

    // Check if requester is super-admin
    const isSuperAdmin = await adminService.isSuperAdmin(creatorEmail);
    if (!isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only super-admins can manage admin roles' });
    }

    const adminRole = await adminService.setAdminRole(email, role, assignedProjects || [], creatorEmail);

    return res.status(200).json({
      success: true,
      message: `Admin role ${role} assigned to ${email}`,
      data: adminRole
    });
  } catch (error) {
    console.error('Error setting admin role:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/admin/roles/:email
 * Remove an admin role (super-admin only)
 */
app.delete('/api/v1/admin/roles/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const requesterEmail = req.headers['x-user-email'];

    // Check if requester is super-admin
    const isSuperAdmin = await adminService.isSuperAdmin(requesterEmail);
    if (!isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Only super-admins can remove admin roles' });
    }

    // Prevent removing own role
    if (email === requesterEmail) {
      return res.status(400).json({ success: false, error: 'Cannot remove your own admin role' });
    }

    const success = await adminService.deleteAdminRole(email);

    return res.status(200).json({
      success: true,
      message: success ? `Admin role removed from ${email}` : `No admin role found for ${email}`
    });
  } catch (error) {
    console.error('Error deleting admin role:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/admin/project-admins/:projectId
 * Get all admins for a specific project
 */
app.get('/api/v1/admin/project-admins/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const admins = await adminService.getProjectAdmins(projectId);

    return res.status(200).json({
      success: true,
      data: admins,
      count: admins.length
    });
  } catch (error) {
    console.error('Error getting project admins:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// ACCESS MANAGEMENT ENDPOINTS
// ============================================

/**
 * GET /api/v1/access/granted
 * List all granted accesses with filters
 */
app.get('/api/v1/access/granted', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];
    const { status, projectId, userEmail: filterEmail } = req.query;

    // Check if requester is admin using resolved logic
    const adminRole = await adminService.resolveAdminRole(userEmail);

    const filters = {};
    if (status) filters.status = status;

    if (adminRole) {
      // Admins can filter by project
      if (projectId) filters.projectId = projectId;
      if (filterEmail) filters.userEmail = filterEmail;

      // Project-admins can only see their assigned projects
      if (adminRole.role === 'project-admin' && !projectId) {
        // Return accesses for all assigned projects
        const allAccesses = [];
        for (const proj of adminRole.assignedProjects) {
          const accesses = await grantedAccessService.getGrantedAccesses({ ...filters, projectId: proj });
          allAccesses.push(...accesses);
        }
        return res.status(200).json({ success: true, data: allAccesses, count: allAccesses.length });
      }
    } else {
      // Non-admins can only see their own accesses
      filters.userEmail = userEmail;
    }

    const accesses = await grantedAccessService.getGrantedAccesses(filters);

    return res.status(200).json({
      success: true,
      data: accesses,
      count: accesses.length
    });
  } catch (error) {
    console.error('Error fetching granted accesses:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/access/asset/:assetName
 * Get all users with access to a specific asset
 */
app.get('/api/v1/access/asset/{*assetPath}', async (req, res) => {
  try {
    // Express 5: named wildcard params
    const assetName = req.params.assetPath;

    const accesses = await grantedAccessService.getAccessesByAsset(assetName);

    return res.status(200).json({
      success: true,
      data: accesses,
      count: accesses.length
    });
  } catch (error) {
    console.error('Error fetching accesses for asset:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// NOTE: POST /api/v1/access/revoke is defined above (line ~3276) - single endpoint handles
// grant lookup, admin auth check, dataset-level IAM removal, and Firestore update.

/**
 * POST /api/v1/access/bulk-approve
 * Bulk approve multiple access requests
 */
app.post('/api/v1/access/bulk-approve', async (req, res) => {
  try {
    const { requestIds } = req.body;
    const reviewerEmail = req.headers['x-user-email'];

    if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Request IDs array is required' });
    }

    const results = {
      successful: [],
      failed: []
    };

    for (const requestId of requestIds) {
      try {
        const fullRequest = await getAccessRequestById(requestId);
        if (!fullRequest) {
          results.failed.push({ requestId, error: 'Request not found' });
          continue;
        }

        // Check admin permission
        const isAdmin = await adminService.isProjectAdmin(reviewerEmail, fullRequest.gcpProjectId);
        if (!isAdmin) {
          results.failed.push({ requestId, error: 'Not authorized' });
          continue;
        }

        // Grant IAM access
        const role = fullRequest.requestedRole || 'roles/bigquery.dataViewer';
        await grantIamAccess(fullRequest.gcpProjectId, fullRequest.requesterEmail, role);

        // Create granted access record
        const grantedAccess = await grantedAccessService.createGrantedAccess({
          userEmail: fullRequest.requesterEmail,
          assetName: fullRequest.assetName,
          gcpProjectId: fullRequest.gcpProjectId,
          role: role,
          grantedBy: reviewerEmail,
          originalRequestId: requestId
        });

        // Update request status
        await updateAccessRequestStatus(requestId, 'approved', null, reviewerEmail);

        // Send notification
        await notificationService.notifyAccessApproved(fullRequest, reviewerEmail);

        results.successful.push({ requestId, grantedAccessId: grantedAccess.id });
      } catch (err) {
        results.failed.push({ requestId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${requestIds.length} requests`,
      results
    });
  } catch (error) {
    console.error('Error bulk approving:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/access/bulk-reject
 * Bulk reject multiple access requests
 */
app.post('/api/v1/access/bulk-reject', async (req, res) => {
  try {
    const { requestIds, reason } = req.body;
    const reviewerEmail = req.headers['x-user-email'];

    if (!requestIds || !Array.isArray(requestIds) || requestIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Request IDs array is required' });
    }

    const results = {
      successful: [],
      failed: []
    };

    for (const requestId of requestIds) {
      try {
        const fullRequest = await getAccessRequestById(requestId);
        if (!fullRequest) {
          results.failed.push({ requestId, error: 'Request not found' });
          continue;
        }

        // Check admin permission
        const isAdmin = await adminService.isProjectAdmin(reviewerEmail, fullRequest.gcpProjectId);
        if (!isAdmin) {
          results.failed.push({ requestId, error: 'Not authorized' });
          continue;
        }

        // Update request status
        await updateAccessRequestStatus(requestId, 'rejected', reason, reviewerEmail);

        // Send notification
        await notificationService.notifyAccessRejected(fullRequest, reviewerEmail, reason);

        results.successful.push({ requestId });
      } catch (err) {
        results.failed.push({ requestId, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${requestIds.length} requests`,
      results
    });
  } catch (error) {
    console.error('Error bulk rejecting:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/access/stats/:projectId
 * Get access statistics for a project
 */
app.get('/api/v1/access/stats/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const stats = await grantedAccessService.getAccessStats(projectId);

    return res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error getting access stats:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// NOTIFICATION ENDPOINTS
// ============================================

/**
 * GET /api/v1/notifications
 * Get notifications for current user
 */
app.get('/api/v1/notifications', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];
    const { limit } = req.query;

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email is required' });
    }

    const filters = {};
    if (limit) filters.limit = parseInt(limit, 10);

    const notifications = await notificationService.getNotifications(userEmail, filters);

    return res.status(200).json({
      success: true,
      data: notifications,
      count: notifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/notifications/unread-count
 * Get unread notification count for current user
 */
app.get('/api/v1/notifications/unread-count', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email is required' });
    }

    const count = await notificationService.getUnreadCount(userEmail);

    return res.status(200).json({
      success: true,
      count
    });
  } catch (error) {
    console.error('Error getting unread count:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/notifications/mark-read
 * Mark notifications as read
 */
app.post('/api/v1/notifications/mark-read', async (req, res) => {
  try {
    const { notificationIds } = req.body;

    if (!notificationIds || !Array.isArray(notificationIds)) {
      return res.status(400).json({ success: false, error: 'Notification IDs array is required' });
    }

    const count = await notificationService.markAsRead(notificationIds);

    return res.status(200).json({
      success: true,
      message: `Marked ${count} notifications as read`
    });
  } catch (error) {
    console.error('Error marking notifications as read:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/notifications/mark-all-read
 * Mark all notifications as read for current user
 */
app.post('/api/v1/notifications/mark-all-read', async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email is required' });
    }

    const count = await notificationService.markAllAsRead(userEmail);

    return res.status(200).json({
      success: true,
      message: `Marked ${count} notifications as read`
    });
  } catch (error) {
    console.error('Error marking all as read:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/v1/notifications/:id
 * Delete a specific notification
 */
app.delete('/api/v1/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const success = await notificationService.deleteNotification(id);

    return res.status(200).json({
      success: true,
      message: success ? 'Notification deleted' : 'Notification not found'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH CHECK ENDPOINTS
// ============================================

/**
 * GET /api/access-request/health
 * Health check endpoint for access request service
 */
app.get('/api/access-request/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Access request service is healthy',
    timestamp: new Date().toISOString(),
    service: 'email-service',
    version: '1.0.0'
  });
});

// Basic health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).send('API is running!');
});
// Basic health check endpoint
app.get('/', (req, res) => {
  res.redirect('/home'); // Redirects to the /home route
});

// For any other routes, serve the React index.html
app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================
// GLOBAL ERROR HANDLER (Catch-all for unhandled exceptions)
// ============================================
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR HANDLER] Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    details: err.message || 'An unexpected error occurred'
  });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('--- DEPLOYMENT_VERSION: v3.4 - IAM Automation Enabled ---');
  console.log('API Endpoints:');
  console.log(`  POST /api/v1/check-iam-role`);
  console.log(`  POST /api/v1/search`);
  console.log(`  GET /api/health`);
  console.log(`PROJECT_ID: ${PROJECT_ID || 'Not set'}`);
});

