import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// アプリのエントリーポイント
// （地図を二重生成しないため StrictMode は使わない）
const container = document.getElementById('root');
if (!container) {
  throw new Error('ルート要素 #root が見つかりません');
}
createRoot(container).render(<App />);
