# New Feature: Lineage Graph

I have implemented the **Data Lineage Graph** (Relationships) and added it to the Table Overview page, just above "Documentation".

## How to use it:
1.  **Restart Local Backend:** `Ctrl+C` then `node server.js` (Required for the new `/api/v1/lineage` endpoint).
2.  **View a Table:** Go to any Table detail page.
3.  **See Graph:** If the table has lineage data (upstream/downstream), a graph will appear above the Documentation section.

## Features Implemented Recently:
1.  **Automated IAM Provisioning:** Admin "Approve" -> BigQuery Access Granted automatically.
2.  **Data Lineage:** Visual graph of table relationships (Depth 3 BFS traversal).
3.  **Project ID Fixes:** Robust configuration for Cloud Run & Local.
4.  **Email Notifications:** Wired up.
