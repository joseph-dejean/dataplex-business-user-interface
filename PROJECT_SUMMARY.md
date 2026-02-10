# Project Architecture & Infrastructure Summary

## 1. Overview
A full-stack web application for Google Cloud Data Catalog & Dataplex management, featuring a custom business glossary, data exploration, and AI-powered conversational analytics.

## 2. Infrastructure
*   **Deployment Target:** Google Cloud Run (Managed Service)
*   **Containerization:** Docker (Multi-stage build)
    *   **Stage 1 (Builder):** `node:20-alpine` (Builds Frontend)
    *   **Stage 2 (Runner):** `node:20-alpine` (Runs Backend + Serves Static Frontend)
*   **Port:** Exposes port `8080`.
*   **Startup:** `entrypoint.sh` handles runtime environment variable substitution in frontend static assets before starting the Node.js server.

## 3. Frontend (Client)
*   **Core Framework:** React v19.2 (using Vite v6)
*   **Language:** TypeScript (~5.8)
*   **State Management:** Redux Toolkit v2.8 (with React Redux v9)
*   **UI Library:** Material UI (MUI) v7.1
    *   `@mui/icons-material`, `@mui/x-data-grid`, `@mui/x-tree-view`
*   **Styling:** Emotion (`@emotion/react`, `@emotion/styled`)
*   **Authentication:** `@react-oauth/google` v0.12
*   **Visualization:**
    *   `@xyflow/react` v12.9 (React Flow - Lineage Graphs)
    *   `react-d3-tree`, `d3`
    *   `@dagrejs/dagre` (Graph layout)
*   **HTTP Client:** Axios v1.10

## 4. Backend (Server)
*   **Runtime:** Node.js (v20+)
*   **Framework:** Express v5.1
*   **Authentication & IAM:**
    *   `google-auth-library` v10 (Application Default Credentials)
    *   `passport` v0.7, `passport-google-oauth20`
*   **Google Cloud Integrations (SDKs):**
    *   `@google-cloud/bigquery` v8 (Data & IAM)
    *   `@google-cloud/datacatalog` v5 (Search & Tagging)
    *   `@google-cloud/dataplex` v4 (Governance)
    *   `@google-cloud/firestore` v8 (App Persistence)
    *   `@google-cloud/lineage` v2 (Data Lineage)
    *   `@google-cloud/vertexai` v1 (GenAI)
    *   `@google-cloud/resource-manager` v6 (IAM Checks)
*   **Utilities:**
    *   `nodemailer` v7 (Email Notifications)
    *   `axios` (External API calls)

## 5. Key Features
*   **Unified Search:** Wraps Data Catalog API.
*   **Conversational Analytics:** Chat interface using Vertex AI / Gemini Data Analytics.
*   **IAM Automation:** Automated BigQuery access provisioning via Admin approval.
*   **Data Lineage:** Visual graph exploration.
