import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import axios, { AxiosError } from 'axios';

const getProjectNumber = (projectId: string) => {
  try {
    let session = localStorage.getItem('sessionUserData');
    let appConfig = session ? JSON.parse(session)?.appConfig : null;

    if (!appConfig?.projects) {
      console.warn('No projects found in appConfig, using projectId as fallback');
      return projectId;
    }

    let projects: any[] = appConfig.projects;
    let project = projects.find((p) => p.projectId === projectId);

    if (!project?.name) {
      console.warn(`Project ${projectId} not found in appConfig, using projectId as fallback`);
      return projectId;
    }

    let projectName: string = project.name;
    const parts = projectName.split('/');
    return parts.length > 1 ? parts[1] : projectId;
  } catch (error) {
    console.error('Error getting project number:', error);
    return projectId;
  }
}

// createAsyncThunk is used for asynchronous actions.
// It will automatically dispatch pending, fulfilled, and rejected actions.
export const fetchDataProductsList = createAsyncThunk('dataProducts/fetchDataProductsList', async (requestData: any , { rejectWithValue }) => {
  // If the requestData is empty, we are returning an empty list.
  if (!requestData) {
    return [];
  }

  try {
    // fetching data products from API endpoint 
    axios.defaults.headers.common['Authorization'] = requestData.id_token ? `Bearer ${requestData.id_token}` : '';
    const response = await axios.get(
        `https://dataplex.googleapis.com/v1/projects/${import.meta.env.VITE_GOOGLE_PROJECT_ID}/locations/-/dataProducts`
    );

    return response.status === 200 || response.status !== 401 ? [
      ...response.data.dataProducts
     ] : rejectWithValue('Token expired');
    //return mockSearchData; // For testing, we return mock data

  } catch (error) {
    if (error instanceof AxiosError) {
      return rejectWithValue(error.response?.data || error.message);
    }
    return rejectWithValue('An unknown error occurred');
  }
});

export const getDataProductDetails = createAsyncThunk('dataProducts/getDataProductDetails', async (requestData: any , { rejectWithValue }) => {
  // If the requestData is empty, we are returning an empty list.
  if (!requestData) {
    return [];
  }

  try {
    // fetching data products from API endpoint
    axios.defaults.headers.common['Authorization'] = requestData.id_token ? `Bearer ${requestData.id_token}` : '';

    const parts = requestData.dataProductId.split('/');
    const project = parts[1];
    const location = parts[3];
    const dataProductName = parts[5] || parts.pop();

    // First, try to get the data product directly from the Dataplex API
    try {
      const directResponse = await axios.get(
        `https://dataplex.googleapis.com/v1/projects/${project}/locations/${location}/dataProducts/${dataProductName}`
      );

      if (directResponse.status === 200) {
        console.log("Direct API response", directResponse.data);
        // Transform to match expected entry format
        return {
          name: directResponse.data.name,
          entrySource: {
            displayName: directResponse.data.displayName,
            description: directResponse.data.description
          },
          fullyQualifiedName: directResponse.data.name,
          aspects: directResponse.data.aspects || {},
          ...directResponse.data
        };
      }
    } catch (directError) {
      console.log("Direct API failed, trying lookupEntry...", directError);
    }

    // Fallback: Try the lookupEntry API
    const projectNumber = getProjectNumber(project);
    const finalEntryName = `projects/${project}/locations/${location}/entryGroups/@dataplex/entries/projects/${projectNumber}/locations/${location}/dataProducts/${dataProductName}`;
    const lookupUrl = `https://dataplex.googleapis.com/v1/projects/${project}/locations/${location}:lookupEntry`;

    console.log("Lookup URL:", lookupUrl);
    console.log("Entry name:", finalEntryName);

    const response = await axios.get(lookupUrl, {
      params: {
        entry: finalEntryName,
        view: 'ALL'
      }
    });

    console.log("Lookup API response", response);
    return response.status === 200 || response.status !== 401 ? response.data
      : rejectWithValue('Token expired');

  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("Error fetching data product details:", error.response?.data || error.message);
      return rejectWithValue(error.response?.data || error.message);
    }
    return rejectWithValue('An unknown error occurred');
  }
});

export const fetchDataProductsAssetsList = createAsyncThunk('dataProducts/fetchDataProductsAssetsList', async (requestData: any , { rejectWithValue }) => {
  // If the requestData is empty, we are returning an empty list.
  if (!requestData) {
    return [];
  }

  try {
    // fetching data products from API endpoint 
    axios.defaults.headers.common['Authorization'] = requestData.id_token ? `Bearer ${requestData.id_token}` : '';
    const project = requestData.dataProductId.split('/')[1];
    const location = requestData.dataProductId.split('/')[3];
    const finalEntryName = `projects/${project}/locations/${location}/dataProducts/${requestData.dataProductId.split('/').pop()}`;
    
    const response = await axios.get(
        `https://dataplex.googleapis.com/v1/${finalEntryName}/dataAssets`
    );
    console.log("Data Products Assets API response", response);
    return response.status === 200 || response.status !== 401 ? [
      ...response.data.dataAssets
     ] : rejectWithValue('Token expired');
    //return mockSearchData; // For testing, we return mock data

  } catch (error) {
    if (error instanceof AxiosError) {
      return rejectWithValue(error.response?.data || error.message);
    }
    return rejectWithValue('An unknown error occurred');
  }
});


type DataProductsState = {
  dataProductsItems: unknown; // Replace 'unknown' with your actual resource type
  status: 'idle' | 'loading' | 'succeeded' | 'failed';
  error: string | undefined | unknown | null;
  selectedDataProductDetails?: unknown|any; // Replace 'unknown' with your actual resource type
  selectedDataProductStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  selectedDataProductError: string | undefined | unknown | null;
  dataProductAssets: unknown;
  dataProductAssetsStatus: 'idle' | 'loading' | 'succeeded' | 'failed';
  dataProductAssetsError: string | undefined | unknown | null;
};

const initialState: DataProductsState = {
  dataProductsItems: [],
  status: 'idle',
  error: null,
  selectedDataProductDetails: {},
  selectedDataProductStatus: 'idle',
  selectedDataProductError: null,
  dataProductAssets: [],
  dataProductAssetsStatus: 'idle',
  dataProductAssetsError: null,
};

// createSlice generates actions and reducers for a slice of the Redux state.
export const dataproductsSlice = createSlice({
  name: 'dataproducts',
  initialState,
  reducers: {}, // No synchronous reducers needed for this slice
  // The `extraReducers` field lets the slice handle actions defined elsewhere,
  // including actions generated by createAsyncThunk.
  extraReducers: (builder) => {
    builder
      .addCase(fetchDataProductsList.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchDataProductsList.fulfilled, (state, action) => {
        state.status = 'succeeded';
        console.log("Fetched Data Products:", action.payload);
        state.dataProductsItems = action.payload || [];
      })
      .addCase(fetchDataProductsList.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(getDataProductDetails.pending, (state) => {
        state.selectedDataProductStatus = 'loading';
      })
      .addCase(getDataProductDetails.fulfilled, (state, action) => {
        state.selectedDataProductStatus = 'succeeded';
        state.selectedDataProductDetails = action.payload;
      })
      .addCase(getDataProductDetails.rejected, (state, action) => {
        state.selectedDataProductStatus = 'failed';
        state.selectedDataProductError = action.payload;
      })
      .addCase(fetchDataProductsAssetsList.pending, (state) => {
        state.dataProductAssetsStatus = 'loading';
      })
      .addCase(fetchDataProductsAssetsList.fulfilled, (state, action) => {
        state.dataProductAssetsStatus = 'succeeded';
        console.log("Fetched Data Products Assets:", action.payload);
        state.dataProductAssets = action.payload || [];
      })
      .addCase(fetchDataProductsAssetsList.rejected, (state, action) => {
        state.dataProductAssetsStatus = 'failed';
        state.dataProductAssetsError = action.payload;
      })
  },
});

export default dataproductsSlice.reducer;