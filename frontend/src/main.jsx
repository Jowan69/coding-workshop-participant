import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { redirectPathToHash } from './utils/pathRedirect';

// /projects/5 (served as index.html by CloudFront) becomes /#/projects/5 before routing starts.
redirectPathToHash();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
