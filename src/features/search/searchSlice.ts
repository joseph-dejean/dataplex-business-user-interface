import { createSlice } from '@reduxjs/toolkit';

type searchState = {
  searchTerm: string | null;
  searchResult: unknown | null; // Replace 'unknown' with your actual search result type
  searchType: string; // Add search type to persist dropdown selection
  searchFilters:any[];
  semanticSearch?: boolean;
  agentSearch?: boolean; // Use the ADK discovery agent for search
  isSearchFiltersOpen: boolean;
  isSideNavOpen: boolean;
  searchSubmitted: boolean;
};

const initialState : searchState = {
  searchTerm: '',
  searchResult: null,
  searchType: 'All', // Default to 'All',
  searchFilters:[],
  semanticSearch: true,
  agentSearch: false,
  isSearchFiltersOpen: true,
  isSideNavOpen: true,
  searchSubmitted: false,
};

export const searchSlice = createSlice({
  name: 'search',
  initialState,
  reducers: {
    setSearchTerm: (state, action) => {
      state.searchTerm = action.payload.searchTerm;
    },
    setSearchResult: (state, action) => {
      state.searchResult = action.payload;
    },
    setSearchType: (state, action) => {
      state.searchType = action.payload.searchType;
    },
    setSearchFilters: (state, action) => {
      state.searchFilters = action.payload.searchFilters;
    },
    setSemanticSearch: (state, action) => {
      state.semanticSearch = action.payload.semanticSearch;
    },
    setAgentSearch: (state, action) => {
      state.agentSearch = action.payload.agentSearch;
    },
    setSearchFiltersOpen: (state, action) => {
      state.isSearchFiltersOpen = action.payload;
    },
    setSideNavOpen: (state, action) => {
      state.isSideNavOpen = action.payload;
    },
    setSearchSubmitted: (state, action) => {
      state.searchSubmitted = action.payload;
    },
  },
});

export const { setSearchResult, setSearchTerm, setSearchType, setSearchFilters, setSemanticSearch, setAgentSearch, setSearchFiltersOpen, setSideNavOpen, setSearchSubmitted } = searchSlice.actions;

export default searchSlice.reducer;
