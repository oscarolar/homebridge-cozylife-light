import {API} from 'homebridge';
import {CozyLifeLightPlatform, PLATFORM_NAME} from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, CozyLifeLightPlatform);
};
