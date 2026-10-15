/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {setupBackgroundHandler} from './src/services/backgroundHandler';

setupBackgroundHandler();

AppRegistry.registerComponent(appName, () => App);
