import React, { useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Box, Typography, Grid, Paper, Skeleton, Button } from '@mui/material';
import { ArrowBack, CreateNewFolderOutlined } from '@mui/icons-material';
import type { AppDispatch } from '../../app/store';
import { useAuth } from '../../auth/AuthProvider';
import {
  fetchDataProductsList,
  getDataProductDetails,
  setDataProductsDetailTabValue,
} from '../../features/dataProducts/dataProductsSlice';
import { fetchDomains, type Domain } from '../../features/domains/domainsSlice';

/**
 * Domain detail page: shows the data products that belong to one domain
 * (vertical). Reached from the Data Products page by opening a domain.
 */
const DomainDetailPage: React.FC = () => {
  const { domainId } = useParams<{ domainId: string }>();
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useAuth();
  const id_token = user?.token || '';
  const userEmail = (user as any)?.email || '';

  const domains = useSelector((state: any) => state.domains.domains) as Domain[];
  const { dataProductsItems, status } = useSelector((state: any) => state.dataProducts);

  useEffect(() => {
    if (id_token) dispatch(fetchDomains({ id_token, userEmail }));
    if ((!dataProductsItems || dataProductsItems.length === 0) && status === 'idle' && id_token) {
      dispatch(fetchDataProductsList({ id_token }));
    }
  }, [dispatch, id_token, userEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const domain = useMemo(() => domains.find((d) => d.id === domainId), [domains, domainId]);

  const products = useMemo(() => {
    const ids = new Set(domain?.productIds || []);
    return (dataProductsItems || []).filter((p: any) => ids.has(p.name));
  }, [domain, dataProductsItems]);

  const openProduct = (dataProduct: any) => {
    dispatch(getDataProductDetails({ dataProductId: dataProduct.name, id_token }));
    dispatch(setDataProductsDetailTabValue(0));
    localStorage.setItem('selectedDataProduct', JSON.stringify(dataProduct));
    navigate(`/data-products-details?dataProductId=${encodeURIComponent(dataProduct.name)}`);
  };

  const loading = status === 'loading';

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, height: 'calc(100vh - 3.9rem)', overflowY: 'auto' }}>
      <Button startIcon={<ArrowBack />} onClick={() => navigate('/data-products')} sx={{ textTransform: 'none', color: '#0B57D0', mb: 1 }}>
        Data Products
      </Button>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
        <CreateNewFolderOutlined sx={{ color: '#0B57D0', fontSize: '1.8rem' }} />
        <Typography variant="h5" sx={{ fontWeight: 600, color: '#1F1F1F' }}>
          {domain ? domain.name : (domainId || 'Domain')}
        </Typography>
        <Typography variant="body2" sx={{ color: '#5f6368' }}>
          ({products.length} data product{products.length === 1 ? '' : 's'})
        </Typography>
      </Box>
      {domain?.description && (
        <Typography variant="body2" sx={{ color: '#5f6368', mb: 3 }}>{domain.description}</Typography>
      )}

      {loading ? (
        <Grid container spacing={2.5}>
          {Array.from(new Array(3)).map((_, i) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={i}>
              <Skeleton variant="rounded" height={140} />
            </Grid>
          ))}
        </Grid>
      ) : products.length === 0 ? (
        <Typography variant="body1" color="text.secondary" sx={{ mt: 4 }}>
          No data products in this domain yet. Open Data Products and use the ⋮ menu on a product to move it here.
        </Typography>
      ) : (
        <Grid container spacing={2.5}>
          {products.map((p: any) => (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={p.name}>
              <Paper
                elevation={0}
                onClick={() => openProduct(p)}
                sx={{
                  border: '1px solid #E0E0E0', borderRadius: '16px', p: 2, height: '100%',
                  cursor: 'pointer', transition: 'box-shadow .2s, border-color .2s',
                  '&:hover': { boxShadow: '0 1px 6px rgba(0,0,0,0.12)', borderColor: '#0B57D0' },
                }}
              >
                <Typography sx={{ fontWeight: 600, color: '#1F1F1F', mb: 0.5 }}>
                  {p.displayName || p.name?.split('/').pop()}
                </Typography>
                <Typography variant="body2" sx={{ color: '#5f6368', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {p.description || 'No description'}
                </Typography>
              </Paper>
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
};

export default DomainDetailPage;
