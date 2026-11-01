import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// The UI is set in Inter, the product name in Space Grotesk and numbers in JetBrains Mono, as Shei
// Designs sets them; bundled so every platform matches.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
