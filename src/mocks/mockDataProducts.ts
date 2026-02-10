import type { DataProduct } from '../types/DataProduct';

/**
 * Mock Data Products for France Practice
 * These are placeholder Data Products that don't exist yet, shown with "Coming Soon" badge
 */
export const mockDataProducts: DataProduct[] = [
  {
    id: 'dp-customer-360',
    name: 'customer-360',
    displayName: 'Customer 360',
    description: 'Comprehensive customer data product combining customer profiles, transactions, and interactions across all touchpoints.',
    tables: [],
    owner: 'Data Team',
    tags: ['customer', 'analytics', 'crm'],
    status: 'coming-soon',
    metadata: {
      aspectTypes: ['customer_profile', 'transaction_history'],
      project: 'france-practice',
      location: 'us-central1'
    }
  },
  {
    id: 'dp-sales-performance',
    name: 'sales-performance',
    displayName: 'Sales Performance Analytics',
    description: 'Unified view of sales metrics, pipeline, and revenue data for performance tracking and forecasting.',
    tables: [],
    owner: 'Sales Operations',
    tags: ['sales', 'revenue', 'forecasting'],
    status: 'coming-soon',
    metadata: {
      aspectTypes: ['sales_metrics', 'pipeline'],
      project: 'france-practice',
      location: 'us-central1'
    }
  },
  {
    id: 'dp-product-catalog',
    name: 'product-catalog',
    displayName: 'Product Catalog',
    description: 'Master product data including SKUs, pricing, inventory, and product hierarchies.',
    tables: [],
    owner: 'Product Team',
    tags: ['products', 'inventory', 'catalog'],
    status: 'coming-soon',
    metadata: {
      aspectTypes: ['product_info', 'inventory'],
      project: 'france-practice',
      location: 'us-central1'
    }
  },
  {
    id: 'dp-financial-reporting',
    name: 'financial-reporting',
    displayName: 'Financial Reporting',
    description: 'Consolidated financial data for reporting, compliance, and analysis including P&L, balance sheets, and cash flow.',
    tables: [],
    owner: 'Finance Team',
    tags: ['finance', 'reporting', 'compliance'],
    status: 'coming-soon',
    metadata: {
      aspectTypes: ['financial_data', 'compliance'],
      project: 'france-practice',
      location: 'us-central1'
    }
  }
];

/**
 * Helper function to check if a Data Product is coming soon
 */
export const isComingSoon = (dataProduct: DataProduct): boolean => {
  return dataProduct.status === 'coming-soon';
};

/**
 * Helper function to get Data Product by ID
 */
export const getDataProductById = (id: string): DataProduct | undefined => {
  return mockDataProducts.find(dp => dp.id === id);
};

/**
 * Helper function to get Data Products by status
 */
export const getDataProductsByStatus = (status: DataProduct['status']): DataProduct[] => {
  return mockDataProducts.filter(dp => dp.status === status);
};



