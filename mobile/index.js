import { registerBackgroundHandlers } from './firebaseMessaging';

registerBackgroundHandlers('http://192.168.20.128:3000');// must match BACKEND_URL in App.js

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);