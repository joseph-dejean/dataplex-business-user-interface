const dataProducts = [
    {
        id: "dp-coffeeshop",
        name: "Coffee Shop Analytics",
        displayName: "Coffee Shop Analytics",
        description: "Operational data for the Coffee Shop chain, including menu items and transaction history.",
        status: "LIVE",
        owner: "operations@aeyelytics.com",
        tags: ["Retail", "Operations"],
        assets: [
            {
                entryName: "projects/aeyelytics/locations/us-central1/entryGroups/default/entries/coffee_shop.menu",
                name: "menu",
                displayName: "Menu Items",
                description: "List of all menu items and their prices.",
                type: "TABLE",
                fullyQualifiedName: "bigquery:aeyelytics.coffee_shop.menu",
                system: "BIGQUERY"
            },
            {
                entryName: "projects/aeyelytics/locations/us-central1/entryGroups/default/entries/coffee_shop.sales",
                name: "sales",
                displayName: "Sales Transactions",
                description: "Daily sales transactions.",
                type: "TABLE",
                fullyQualifiedName: "bigquery:aeyelytics.coffee_shop.sales",
                system: "BIGQUERY"
            }
        ],
        metadata: {
            project: "aeyelytics",
            dataset: "coffee_shop",
            location: "us-central1"
        }
    }
];

const aspects = {
    // keeping mock aspects just in case, though primarily using real assets now
    "dp-coffeeshop": {
        "data-quality": { score: 98, status: "PASS" },
        "security": { status: "ENCRYPTED" }
    }
};

module.exports = { dataProducts, aspects };
