// Redux state persistence utilities
// Define the state structure locally to avoid circular imports
type PersistedState = {
  search?: any;
  resources?: any;
  entry?: any;
};

// Keys for localStorage
const PERSISTENCE_KEYS = {
  SEARCH: 'searchState',
  RESOURCES: 'resourcesState',
  ENTRY: 'entryState',
} as const;

// Define which parts of the state should be persisted
export const PERSISTED_STATE_KEYS = [
  'search',
  'resources',
  'entry'
] as const;

// How long cached RESULT data (search results, browse cache, access checks)
// stays valid across full page reloads. After this, we drop the cached results
// so a reload re-fetches fresh data — otherwise a dataset you deleted in
// BigQuery keeps reappearing from stale localStorage. User preferences (filters,
// search type, etc.) are NOT time-limited; only result data is.
const RESULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Save state to localStorage
export const saveStateToStorage = (state: PersistedState) => {
  try {
    // Save search state
    if (state.search) {
      localStorage.setItem(PERSISTENCE_KEYS.SEARCH, JSON.stringify(state.search));
    }
    
    // Save resources state (stamped so we can expire stale cached results)
    if (state.resources) {
      localStorage.setItem(
        PERSISTENCE_KEYS.RESOURCES,
        JSON.stringify({ ...state.resources, _savedAt: Date.now() })
      );
    }

    // Save entry state (but not history to avoid circular references)
    if (state.entry) {
      const entryStateToSave = {
        ...state.entry,
        history: [], // Don't persist history
        _savedAt: Date.now()
      };
      localStorage.setItem(PERSISTENCE_KEYS.ENTRY, JSON.stringify(entryStateToSave));
    }
  } catch (error) {
    console.warn('Failed to save state to localStorage:', error);
  }
};

// Load state from localStorage
export const loadStateFromStorage = (): PersistedState => {
  try {
    const searchState = localStorage.getItem(PERSISTENCE_KEYS.SEARCH);
    const resourcesState = localStorage.getItem(PERSISTENCE_KEYS.RESOURCES);
    const entryState = localStorage.getItem(PERSISTENCE_KEYS.ENTRY);

    const persistedState: PersistedState = {};

    if (searchState) {
      persistedState.search = JSON.parse(searchState);
    }

    if (resourcesState) {
      const parsed = JSON.parse(resourcesState);
      const isStale = !parsed._savedAt || (Date.now() - parsed._savedAt) > RESULT_CACHE_TTL_MS;
      if (isStale) {
        // Drop cached result lists / browse cache so we re-fetch fresh data and
        // don't show datasets that were deleted since the cache was written.
        parsed.items = [];
        parsed.itemsStore = [];
        parsed.itemsRequestData = null;
        parsed.itemsNextPageSize = null;
        parsed.totalItems = 0;
        parsed.aspectBrowseCache = {};
        parsed.entryListData = [];
      }
      delete parsed._savedAt;
      persistedState.resources = parsed;
    }

    if (entryState) {
      const parsed = JSON.parse(entryState);
      // Ensure accessCheckCache always exists (may be missing from older persisted state)
      if (!parsed.accessCheckCache) {
        parsed.accessCheckCache = {};
      }
      // Expire cached access checks (a deleted dataset shouldn't keep its old
      // "has access" verdict on the next reload).
      const isStale = !parsed._savedAt || (Date.now() - parsed._savedAt) > RESULT_CACHE_TTL_MS;
      if (isStale) {
        parsed.accessCheckCache = {};
      }
      delete parsed._savedAt;
      persistedState.entry = parsed;
    }

    return persistedState;
  } catch (error) {
    console.warn('Failed to load state from localStorage:', error);
    return {};
  }
};

// Clear persisted state
export const clearPersistedState = () => {
  try {
    Object.values(PERSISTENCE_KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
  } catch (error) {
    console.warn('Failed to clear persisted state:', error);
  }
};
