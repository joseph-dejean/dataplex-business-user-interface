import React, { useState, useEffect } from 'react';
import {
  Box,
  Drawer,
  Typography,
  IconButton,
  Divider,
  Chip,
  Button,
  TextField,
  InputAdornment
} from '@mui/material';
import { Close, FilterList, Search as SearchIcon } from '@mui/icons-material';
import { mockDataProducts } from '../../mocks/mockDataProducts';
import axios from 'axios';
import { URLS } from '../../constants/urls';
import { useAuth } from '../../auth/AuthProvider';

interface GlobalFilterSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  selectedAspects: string[];
  selectedDataProducts: string[];
  onAspectChange: (aspects: string[]) => void;
  onDataProductChange: (dataProducts: string[]) => void;
  availableAspects?: string[]; // List of available aspects from the system
}

const GlobalFilterSidebar: React.FC<GlobalFilterSidebarProps> = ({
  isOpen,
  onClose,
  selectedAspects,
  selectedDataProducts,
  onAspectChange,
  onDataProductChange,
  availableAspects: propAvailableAspects = []
}) => {
  const { user } = useAuth();
  const [aspectSearch, setAspectSearch] = useState('');
  const [dataProductSearch, setDataProductSearch] = useState('');
  const [availableAspects, setAvailableAspects] = useState<string[]>(propAvailableAspects);

  // Fetch available aspects from the system
  useEffect(() => {
    if (isOpen && availableAspects.length === 0) {
      fetchAvailableAspects();
    }
  }, [isOpen]);

  const fetchAvailableAspects = async () => {
    try {
      // Fetch aspect types from the backend
      const response = await axios.get(`${URLS.API_URL}/aspect-types`, {
        headers: {
          Authorization: `Bearer ${user?.token}`
        }
      });
      
      if (response.data && Array.isArray(response.data)) {
        const aspectNames = response.data
          .map((aspect: any) => aspect.displayName || aspect.name)
          .filter((name: string) => name && name.trim() !== '');
        setAvailableAspects([...new Set(aspectNames)]);
      }
    } catch (error) {
      console.error('Error fetching aspects:', error);
      // Fallback to prop if available
      if (propAvailableAspects.length > 0) {
        setAvailableAspects(propAvailableAspects);
      }
    }
  };

  // Filter aspects based on search
  const filteredAspects = availableAspects.filter(aspect =>
    aspect.toLowerCase().includes(aspectSearch.toLowerCase())
  );

  // Filter data products based on search
  const filteredDataProducts = mockDataProducts.filter(dp =>
    dp.displayName.toLowerCase().includes(dataProductSearch.toLowerCase()) ||
    dp.description.toLowerCase().includes(dataProductSearch.toLowerCase()) ||
    dp.tags?.some(tag => tag.toLowerCase().includes(dataProductSearch.toLowerCase()))
  );

  const handleAspectToggle = (aspect: string) => {
    if (selectedAspects.includes(aspect)) {
      onAspectChange(selectedAspects.filter(a => a !== aspect));
    } else {
      onAspectChange([...selectedAspects, aspect]);
    }
  };

  const handleDataProductToggle = (dataProductId: string) => {
    if (selectedDataProducts.includes(dataProductId)) {
      onDataProductChange(selectedDataProducts.filter(id => id !== dataProductId));
    } else {
      onDataProductChange([...selectedDataProducts, dataProductId]);
    }
  };

  const handleClearAll = () => {
    onAspectChange([]);
    onDataProductChange([]);
    setAspectSearch('');
    setDataProductSearch('');
  };

  return (
    <Drawer
      anchor="left"
      open={isOpen}
      onClose={onClose}
      sx={{
        '& .MuiDrawer-paper': {
          width: 320,
          boxSizing: 'border-box',
          backgroundColor: '#FFFFFF',
          borderRight: '1px solid #DADCE0'
        }
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header */}
        <Box sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid #DADCE0'
        }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <FilterList sx={{ color: '#0E4DCA' }} />
            <Typography variant="h6" sx={{ fontWeight: 500, color: '#1F1F1F' }}>
              Filters
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small">
            <Close />
          </IconButton>
        </Box>

        {/* Content */}
        <Box sx={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {/* Clear All Button */}
          {(selectedAspects.length > 0 || selectedDataProducts.length > 0) && (
            <Box sx={{ marginBottom: 2 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={handleClearAll}
                sx={{
                  textTransform: 'none',
                  fontSize: '0.875rem',
                  color: '#575757',
                  borderColor: '#DADCE0'
                }}
              >
                Clear All Filters
              </Button>
            </Box>
          )}

          {/* Aspect Filter Section */}
          <Box sx={{ marginBottom: 3 }}>
            <Typography variant="subtitle2" sx={{ 
              fontWeight: 500, 
              color: '#1F1F1F',
              marginBottom: 1.5
            }}>
              Filter by Aspect
            </Typography>
            
            <TextField
              fullWidth
              size="small"
              placeholder="Search aspects..."
              value={aspectSearch}
              onChange={(e) => setAspectSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 18, color: '#575757' }} />
                  </InputAdornment>
                )
              }}
              sx={{ marginBottom: 1.5 }}
            />

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {filteredAspects.length > 0 ? (
                filteredAspects.map((aspect) => (
                  <Chip
                    key={aspect}
                    label={aspect}
                    onClick={() => handleAspectToggle(aspect)}
                    color={selectedAspects.includes(aspect) ? 'primary' : 'default'}
                    variant={selectedAspects.includes(aspect) ? 'filled' : 'outlined'}
                    sx={{
                      fontSize: '0.75rem',
                      height: '28px',
                      cursor: 'pointer'
                    }}
                  />
                ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  {availableAspects.length === 0 ? 'No aspects available' : 'No aspects match your search'}
                </Typography>
              )}
            </Box>
          </Box>

          <Divider sx={{ marginY: 2 }} />

          {/* Data Product Filter Section */}
          <Box>
            <Typography variant="subtitle2" sx={{ 
              fontWeight: 500, 
              color: '#1F1F1F',
              marginBottom: 1.5
            }}>
              Filter by Data Product
            </Typography>
            
            <TextField
              fullWidth
              size="small"
              placeholder="Search data products..."
              value={dataProductSearch}
              onChange={(e) => setDataProductSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 18, color: '#575757' }} />
                  </InputAdornment>
                )
              }}
              sx={{ marginBottom: 1.5 }}
            />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {filteredDataProducts.length > 0 ? (
                filteredDataProducts.map((dp) => (
                  <Box
                    key={dp.id}
                    onClick={() => handleDataProductToggle(dp.id)}
                    sx={{
                      padding: 1,
                      borderRadius: 1,
                      border: selectedDataProducts.includes(dp.id) 
                        ? '2px solid #0E4DCA' 
                        : '1px solid #DADCE0',
                      backgroundColor: selectedDataProducts.includes(dp.id) 
                        ? '#EDF2FC' 
                        : 'transparent',
                      cursor: 'pointer',
                      '&:hover': {
                        backgroundColor: selectedDataProducts.includes(dp.id) 
                          ? '#EDF2FC' 
                          : '#F8FAFD'
                      }
                    }}
                  >
                    <Typography variant="body2" sx={{ 
                      fontWeight: selectedDataProducts.includes(dp.id) ? 600 : 400,
                      color: '#1F1F1F',
                      marginBottom: 0.5
                    }}>
                      {dp.displayName}
                    </Typography>
                    {dp.status === 'coming-soon' && (
                      <Chip
                        label="Coming Soon"
                        size="small"
                        sx={{
                          height: '20px',
                          fontSize: '0.625rem',
                          backgroundColor: '#FFF3E0',
                          color: '#F57C00'
                        }}
                      />
                    )}
                  </Box>
                ))
              ) : (
                <Typography variant="caption" color="text.secondary">
                  No data products match your search
                </Typography>
              )}
            </Box>
          </Box>
        </Box>

        {/* Footer with active filters count */}
        {(selectedAspects.length > 0 || selectedDataProducts.length > 0) && (
          <Box sx={{
            padding: '12px 20px',
            borderTop: '1px solid #DADCE0',
            backgroundColor: '#F8FAFD'
          }}>
            <Typography variant="caption" color="text.secondary">
              {selectedAspects.length + selectedDataProducts.length} filter(s) active
            </Typography>
          </Box>
        )}
      </Box>
    </Drawer>
  );
};

export default GlobalFilterSidebar;

