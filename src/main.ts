import '@fontsource-variable/pixelify-sans';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/base.css';
import { mount } from 'svelte';
import App from './ui/App.svelte';
import { locale } from './app/i18n.ts';
import { installAudioUnlock } from './app/sfx.ts';
import { app, installDevHook } from './app/state.svelte.ts';
import { loadStageColors } from './ui/stage-renderer.ts';

document.documentElement.lang = locale;
installAudioUnlock();
loadStageColors();
if (import.meta.env.DEV) installDevHook();

const target = document.getElementById('app');
if (!target) throw new Error('#app is missing in index.html');

// The desktop window takes its interface zoom before the first paint; a failed call still mounts the app.
await app.startZoom();

export default mount(App, { target });
