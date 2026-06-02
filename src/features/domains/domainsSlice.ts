import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axios, { AxiosError } from 'axios';
import { URLS } from '../../constants/urls';

// A domain (vertical) groups data products. Stored app-side (Firestore), not Dataplex.
export interface Domain {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  productIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const authHeaders = (req: any) => ({
  headers: {
    Authorization: req?.id_token ? `Bearer ${req.id_token}` : '',
    'x-user-email': req?.userEmail || '',
  },
});

export const fetchDomains = createAsyncThunk('domains/fetch', async (req: any, { rejectWithValue }) => {
  try {
    const res = await axios.get(URLS.API_URL + URLS.DOMAINS, authHeaders(req));
    return res.data.domains as Domain[];
  } catch (error) {
    if (error instanceof AxiosError) return rejectWithValue(error.response?.data || error.message);
    return rejectWithValue('Failed to load domains');
  }
});

export const createDomain = createAsyncThunk('domains/create', async (req: any, { rejectWithValue }) => {
  try {
    const res = await axios.post(URLS.API_URL + URLS.DOMAINS, { name: req.name, description: req.description }, authHeaders(req));
    return res.data.domain as Domain;
  } catch (error) {
    if (error instanceof AxiosError) return rejectWithValue(error.response?.data || error.message);
    return rejectWithValue('Failed to create domain');
  }
});

export const deleteDomain = createAsyncThunk('domains/delete', async (req: any, { rejectWithValue }) => {
  try {
    await axios.delete(`${URLS.API_URL + URLS.DOMAINS}/${req.id}`, authHeaders(req));
    return req.id as string;
  } catch (error) {
    if (error instanceof AxiosError) return rejectWithValue(error.response?.data || error.message);
    return rejectWithValue('Failed to delete domain');
  }
});

export const assignProductToDomain = createAsyncThunk('domains/assign', async (req: any, { rejectWithValue }) => {
  try {
    const res = await axios.post(`${URLS.API_URL + URLS.DOMAINS}/${req.domainId}/assign`, { productId: req.productId }, authHeaders(req));
    return { domain: res.data.domain as Domain, productId: req.productId as string };
  } catch (error) {
    if (error instanceof AxiosError) return rejectWithValue(error.response?.data || error.message);
    return rejectWithValue('Failed to assign product');
  }
});

export const unassignProduct = createAsyncThunk('domains/unassign', async (req: any, { rejectWithValue }) => {
  try {
    await axios.post(`${URLS.API_URL + URLS.DOMAINS}/unassign`, { productId: req.productId }, authHeaders(req));
    return req.productId as string;
  } catch (error) {
    if (error instanceof AxiosError) return rejectWithValue(error.response?.data || error.message);
    return rejectWithValue('Failed to unassign product');
  }
});

type DomainsState = {
  domains: Domain[];
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
  error: unknown;
};

const initialState: DomainsState = { domains: [], status: 'idle', error: null };

export const domainsSlice = createSlice({
  name: 'domains',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchDomains.pending, (state) => { state.status = 'loading'; })
      .addCase(fetchDomains.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.domains = action.payload || [];
      })
      .addCase(fetchDomains.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(createDomain.fulfilled, (state, action) => {
        state.domains.push(action.payload);
      })
      .addCase(deleteDomain.fulfilled, (state, action) => {
        state.domains = state.domains.filter((d) => d.id !== action.payload);
      })
      .addCase(assignProductToDomain.fulfilled, (state, action) => {
        const { domain, productId } = action.payload;
        // Remove the product from every domain, then set the target's list.
        state.domains = state.domains.map((d) => {
          if (d.id === domain.id) return domain;
          return { ...d, productIds: (d.productIds || []).filter((p) => p !== productId) };
        });
      })
      .addCase(unassignProduct.fulfilled, (state, action) => {
        const productId = action.payload;
        state.domains = state.domains.map((d) => ({
          ...d,
          productIds: (d.productIds || []).filter((p) => p !== productId),
        }));
      });
  },
});

export default domainsSlice.reducer;
