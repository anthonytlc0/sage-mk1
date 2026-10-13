import { bootApp } from './app';

const root = document.getElementById('app');
if (!root) throw new Error('Sage MK1: the #app element is missing');
bootApp(root).catch((e: unknown) => console.error('Sage MK1 did not start', e));
