import { mockDataProducts } from '../mocks/mockDataProducts';
import type { DataProduct } from '../types/DataProduct';

/**
 * Search Data Products by term
 * Matches against name, displayName, description, and tags
 */
export const searchDataProducts = (searchTerm: string): DataProduct[] => {
  if (!searchTerm || searchTerm.trim() === '') {
    return [];
  }

  const term = searchTerm.toLowerCase().trim();
  
  return mockDataProducts.filter((product) => {
    const nameMatch = product.name.toLowerCase().includes(term);
    const displayNameMatch = product.displayName.toLowerCase().includes(term);
    const descriptionMatch = product.description.toLowerCase().includes(term);
    const tagMatch = product.tags?.some(tag => tag.toLowerCase().includes(term));
    
    return nameMatch || displayNameMatch || descriptionMatch || tagMatch;
  });
};

/**
 * Convert Data Product to a search result entry format
 * This allows Data Products to be displayed alongside regular entries
 */
export const dataProductToEntry = (dataProduct: DataProduct): any => {
  return {
    name: `data-products/${dataProduct.id}`,
    displayName: dataProduct.displayName,
    fullyQualifiedName: `data-products://${dataProduct.id}`,
    entryType: 'DATA_PRODUCT',
    entrySource: {
      resource: `data-products/${dataProduct.id}`,
      system: 'DATA_PRODUCT',
      displayName: 'Data Product'
    },
    description: dataProduct.description,
    aspects: {},
    // Add metadata for Data Product
    _isDataProduct: true,
    _dataProductId: dataProduct.id,
    _dataProduct: dataProduct
  };
};

/**
 * Merge Data Products into search results
 */
export const mergeDataProductsIntoResults = (searchResults: any[], searchTerm: string): any[] => {
  const matchingDataProducts = searchDataProducts(searchTerm);
  const dataProductEntries = matchingDataProducts.map(dataProductToEntry);
  
  // Combine regular results with Data Products
  return [...dataProductEntries, ...searchResults];
};

/**
 * Filter results by Data Product
 * When a Data Product is selected, show only:
 * 1. The Data Product itself
 * 2. Tables/assets that belong to that Data Product (if tables are defined)
 * If no tables are defined (Coming Soon), show only the Data Product
 */
export const filterByDataProduct = (results: any[], dataProductId: string): any[] => {
  if (!dataProductId || dataProductId === 'all') {
    return results;
  }

  const dataProduct = mockDataProducts.find(dp => dp.id === dataProductId);
  if (!dataProduct) {
    return results;
  }

  // If Data Product has tables defined, filter to show only those tables + the Data Product itself
  if (dataProduct.tables && dataProduct.tables.length > 0) {
    // Create a set of table identifiers (could be FQN, name, or other identifier)
    const tableIdentifiers = new Set(dataProduct.tables);
    
    // Filter results to show:
    // 1. The Data Product itself
    // 2. Tables that match the identifiers
    return results.filter(result => {
      // Include the Data Product itself
      if (result._isDataProduct && result._dataProductId === dataProductId) {
        return true;
      }
      
      // Include tables that match any identifier in the Data Product's tables array
      const resultFQN = result.fullyQualifiedName || result.name || '';
      const resultName = result.entrySource?.displayName || result.name || '';
      
      return tableIdentifiers.has(resultFQN) || 
             tableIdentifiers.has(resultName) ||
             dataProduct.tables.some((table: any) => {
               const tableId = typeof table === 'string' ? table : (table.fullyQualifiedName || table.entryName || table);
               return resultFQN.includes(tableId) || resultName.includes(tableId);
             });
    });
  } else {
    // If no tables defined (Coming Soon), show only the Data Product itself
    return results.filter(result => {
      return (result._isDataProduct && result._dataProductId === dataProductId) ||
             result.name === `data-products/${dataProductId}`;
    });
  }
};

