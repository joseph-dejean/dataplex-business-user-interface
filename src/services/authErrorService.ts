import { AxiosError } from 'axios';

// Global notification functions - set by AuthProvider
let globalShowError: (message: string, duration?: number) => void;
let globalLogout: () => void;

export const setGlobalAuthFunctions = (
  showError: (message: string, duration?: number) => void,
  logout: () => void
) => {
  globalShowError = showError;
  globalLogout = logout;
};

// Check if error is an authentication error - ONLY HTTP 401
export const isAuthenticationError = (error: AxiosError | unknown): boolean => {
  // Only treat HTTP 401 as an authentication error.
  // Other codes (403, 500) should NOT trigger logout - they indicate
  // server errors or permission issues, not expired sessions.
  return (error as AxiosError)?.response?.status === 401;
};

// Handle authentication error with notification and redirect
export const handleAuthenticationError = (error?: AxiosError | unknown) => {
  console.log('Authentication error detected:', (error as AxiosError)?.response?.data || error);

  // Show notification
  if (globalShowError) {
    globalShowError('Your session has expired. You will be redirected to the login page.', 5000);
  }

  // Redirect to login after a delay
  setTimeout(() => {
    if (globalLogout) {
      globalLogout();
    }
  }, 2000);
};

// Check and handle authentication error if detected
export const checkAndHandleAuthError = (error: AxiosError | unknown): boolean => {
  if (isAuthenticationError(error)) {
    handleAuthenticationError(error);
    return true;
  }
  return false;
};
