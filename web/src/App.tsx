import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { Spin } from 'antd';
import MainLayout from './components/MainLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Configs from './pages/Configs';
import Logs from './pages/Logs';
import ImportExport from './pages/ImportExport';

const SystemPage = lazy(() => import('./pages/System'));
const ToolsValidate = lazy(() => import('./pages/ToolsValidate'));
const TomlReference = lazy(() => import('./pages/TomlReference'));
const Settings = lazy(() => import('./pages/Settings'));

const PageFallback = (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 240,
    }}
  >
    <Spin tip="加载中…" size="large" />
  </div>
);

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={PageFallback}>
        <Routes>
          <Route path="/login" element={<Login />} />

          <Route path="/" element={<MainLayout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="configs" element={<Configs />} />
            <Route path="logs" element={<Logs />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="tools">
              <Route index element={<Navigate to="/tools/validate" replace />} />
              <Route path="validate" element={<ToolsValidate />} />
              <Route path="reference" element={<TomlReference />} />
            </Route>
            <Route path="import-export" element={<ImportExport />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
