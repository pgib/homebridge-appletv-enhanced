import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import { Service, PlatformAccessory, CharacteristicValue, Nullable, PrimitiveTypes } from 'homebridge';

import { AppleTVEnhancedPlatform } from './appleTVEnhancedPlatform';
import { NodePyATVDevice, NodePyATVDeviceEvent, NodePyATVDeviceState, NodePyATVMediaType } from '@sebbo2002/node-pyatv';
import md5 from 'md5';
import { spawn } from 'child_process';
import path from 'path';
import CustomPyAtvInstance from './CustomPyAtvInstance';
import { capitalizeFirstLetter, delay, getLocalIP } from './utils';
import { IAppConfigs, ICommonConfig, IInputs, IMediaConfigs, IStateConfigs, NodePyATVApp } from './interfaces';
import { TNodePyATVDeviceState, TNodePyATVMediaType } from './types';
import AccessoryLogger from './AccessoryLogger';


const HIDE_BY_DEFAULT_APPS = [
    'com.apple.podcasts',
    'com.apple.TVAppStore',
    'com.apple.TVSearch',
    'com.apple.Arcade',
    'com.apple.TVHomeSharing',
    'com.apple.TVSettings',
    'com.apple.Fitness',
    'com.apple.TVShows',
    'com.apple.TVMovies',
    'com.apple.facetime',
];


/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class AppleTVEnhancedAccessory {
    private service: Service | undefined = undefined;
    private device: NodePyATVDevice;
    private inputs: IInputs = {};
    private deviceStateServices: { [k: string]: Service } = {};
    private mediaTypeServices: { [k: string]: Service } = {};

    private appConfigs: IAppConfigs | undefined = undefined;
    private commonConfig: ICommonConfig | undefined = undefined;

    private stateConfigs: IStateConfigs | undefined = undefined;
    private mediaConfigs: IMediaConfigs | undefined = undefined;

    private booted: boolean = false;
    private offline: boolean = false;
    private turningOn: boolean = false;
    private lastOnEvent: number = 0;

    private log: AccessoryLogger;

    constructor(
        private readonly platform: AppleTVEnhancedPlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.device = CustomPyAtvInstance.device({ id: this.accessory.context.id as string });

        this.log = new AccessoryLogger(this.platform.log, this.device.name, this.device.id!);

        const credentials = this.getCredentials();
        if (credentials === '') {
            this.pair(this.device.host, this.device.name).then((c) => {
                this.saveCredentials(c);
                this.startUp(c);
                this.log.warn('Paring was successful. Add it to your home in the Home app: com.apple.home://launch');
            });
        } else {
            this.startUp(credentials);
        }
    }

    private async startUp(credentials: string): Promise<void> {
        this.device = CustomPyAtvInstance.device({
            host: this.device.host,
            name: this.device.name,
            id: this.device.id,
            airplayCredentials: credentials,
            companionCredentials: credentials,
        });

        this.accessory.category = this.platform.api.hap.Categories.TV_SET_TOP_BOX;

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Apple Inc.')
            .setCharacteristic(this.platform.Characteristic.Model, this.device.modelName!)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id!)
            .setCharacteristic(this.platform.Characteristic.Name, this.device.name)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.device.version!);

        const configuredName: string = this.getCommonConfig().configuredName || this.accessory.displayName;

        // create the service
        this.service = this.accessory.getService(this.platform.Service.Television) || this.accessory.addService(this.platform.Service.Television);
        this.service
            .setCharacteristic(this.platform.Characteristic.Active, this.platform.Characteristic.Active.INACTIVE)
            .setCharacteristic(this.platform.Characteristic.ActiveIdentifier, this.getCommonConfig().activeIdentifier || this.appIdToNumber('com.apple.TVSettings'))
            .setCharacteristic(this.platform.Characteristic.ConfiguredName, configuredName)
            .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode, this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
            .setCharacteristic(this.platform.Characteristic.CurrentMediaState, this.platform.Characteristic.CurrentMediaState.INTERRUPTED);
        // create handlers for required characteristics of the service
        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .onGet(this.handleActiveGet.bind(this))
            .onSet(this.handleActiveSet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
            .onGet(this.handleActiveIdentifierGet.bind(this))
            .onSet(this.handleActiveIdentifierSet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.ConfiguredName)
            .onGet(this.handleConfiguredNameGet.bind(this))
            .onSet(this.handleConfiguredNameSet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.SleepDiscoveryMode)
            .onGet(this.handleSleepDiscoveryModeGet.bind(this));
        this.service.getCharacteristic(this.platform.Characteristic.RemoteKey)
            .onSet(this.handleRemoteKeySet.bind(this));

        this.log.setAppleTVName(configuredName);

        // create input and sensor services
        const apps = await this.device.listApps();
        this.createInputs(apps);
        this.createDeviceStateSensors();
        this.createMediaTypeSensors();

        // create event listeners to keep everything up-to-date
        this.createListeners();

        this.booted = true;
    }

    private createListeners(): void {
        this.log.debug('recreating listeners');

        const filterErrorHandler = (event: NodePyATVDeviceEvent | Error, listener: (event: NodePyATVDeviceEvent) => void): void => {
            if (!(event instanceof Error)) {
                if (this.offline && event.value !== null) {
                    this.log.info('Reestablished the connection');
                    this.offline = false;
                }
                this.log.debug(`event ${event.key}: ${event.value}`);
                listener(event);
            }
        };

        this.device.on('update:powerState', (e) => filterErrorHandler(e, this.handleActiveUpdate.bind(this)));
        // this.device.on('update:appId', (e) => filterErrorHandler(e, this.handleInputUpdate.bind(this)));
        this.device.on('update:deviceState', (e) => filterErrorHandler(e, this.handleDeviceStateUpdate.bind(this)));
        this.device.on('update:mediaType', (e) => filterErrorHandler(e, this.handleMediaTypeUpdate.bind(this)));

        this.device.on('error', (e) => {
            this.log.debug(e as unknown as string);
            this.offline = true;
            this.log.warn('Lost connection. Trying to reconnect ...');
        });
    }

    private createMediaTypeSensors(): void {
        const mediaTypes = Object.keys(NodePyATVMediaType) as TNodePyATVMediaType[];
        for (let i = 0; i < mediaTypes.length; i++) {
            const mediaType = mediaTypes[i];
            if (this.platform.config.mediaTypes && !this.platform.config.mediaTypes.includes(mediaType)) {
                continue;
            }
            this.log.info(`Adding media type ${mediaType} as a motion sensor.`);
            const s = this.accessory.getService(mediaType) || this.accessory.addService(this.platform.Service.MotionSensor, mediaType, mediaType)
                .setCharacteristic(this.platform.Characteristic.MotionDetected, false)
                .setCharacteristic(this.platform.Characteristic.Name, capitalizeFirstLetter(mediaType))
                .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.getMediaConfig()[mediaType] || capitalizeFirstLetter(mediaType));
            s.getCharacteristic(this.platform.Characteristic.ConfiguredName)
                .onSet(async (value) => {
                    if (value === '') {
                        return;
                    }
                    const oldConfiguredName = s.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
                    if (oldConfiguredName === value) {
                        return;
                    }
                    this.log.info(`Changing configured name of media type sensor ${mediaType} from ${oldConfiguredName} to ${value}.`);
                    this.setMediaTypeConfig(mediaType, value as string);
                });
            s.getCharacteristic(this.platform.Characteristic.MotionDetected)
                .onGet(async () => {
                    if (this.offline) {
                        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    }
                    return s.getCharacteristic(this.platform.Characteristic.MotionDetected).value;
                });
            this.service!.addLinkedService(s);
            this.mediaTypeServices[mediaType] = s;
        }
    }

    private async handleMediaTypeUpdate(event: NodePyATVDeviceEvent): Promise<void> {
        if (event.oldValue !== null && this.mediaTypeServices[event.oldValue]) {
            const s = this.mediaTypeServices[event.oldValue];
            s.setCharacteristic(this.platform.Characteristic.MotionDetected, false);
        }
        if (this.service?.getCharacteristic(this.platform.Characteristic.Active).value === this.platform.Characteristic.Active.INACTIVE) {
            return;
        }
        this.log.info(`New Media Type State: ${event.value}`);
        if (event.value !== null && this.mediaTypeServices[event.value]) {
            const s = this.mediaTypeServices[event.value];
            s.setCharacteristic(this.platform.Characteristic.MotionDetected, true);
        }
    }

    private createDeviceStateSensors(): void {
        const deviceStates = Object.keys(NodePyATVDeviceState) as TNodePyATVDeviceState[];
        for (let i = 0; i < deviceStates.length; i++) {
            const deviceState = deviceStates[i];
            if (this.platform.config.deviceStates && !this.platform.config.deviceStates.includes(deviceState)) {
                continue;
            }
            this.log.info(`Adding device state ${deviceState} as a motion sensor.`);
            const s = this.accessory.getService(deviceState) || this.accessory.addService(this.platform.Service.MotionSensor, deviceState, deviceState)
                .setCharacteristic(this.platform.Characteristic.MotionDetected, false)
                .setCharacteristic(this.platform.Characteristic.Name, capitalizeFirstLetter(deviceState))
                .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.getDeviceStateConfig()[deviceState] || capitalizeFirstLetter(deviceState));
            s.getCharacteristic(this.platform.Characteristic.ConfiguredName)
                .onSet(async (value) => {
                    if (value === '') {
                        return;
                    }
                    const oldConfiguredName = s.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
                    if (oldConfiguredName === value) {
                        return;
                    }
                    this.log.info(`Changing configured name of device state sensor ${deviceState} from ${oldConfiguredName} to ${value}.`);
                    this.setDeviceStateConfig(deviceState, value as string);
                });
            s.getCharacteristic(this.platform.Characteristic.MotionDetected)
                .onGet(async () => {
                    if (this.offline) {
                        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    }
                    return s.getCharacteristic(this.platform.Characteristic.MotionDetected).value;
                });
            this.service!.addLinkedService(s);
            this.deviceStateServices[deviceState] = s;
        }
    }

    private async handleDeviceStateUpdate(event: NodePyATVDeviceEvent): Promise<void> {
        if (event.oldValue !== null && this.deviceStateServices[event.oldValue] !== undefined) {
            const s = this.deviceStateServices[event.oldValue];
            s.setCharacteristic(this.platform.Characteristic.MotionDetected, false);
        }
        if (this.service?.getCharacteristic(this.platform.Characteristic.Active).value === this.platform.Characteristic.Active.INACTIVE) {
            return;
        }
        this.log.info(`New Device State: ${event.value}`);
        if (event.value !== null && this.deviceStateServices[event.value] !== undefined) {
            const s = this.deviceStateServices[event.value];
            s.setCharacteristic(this.platform.Characteristic.MotionDetected, true);
        }
        switch (event.value) {
        case NodePyATVDeviceState.playing:
            this.service?.setCharacteristic(
                this.platform.Characteristic.CurrentMediaState,
                this.platform.Characteristic.CurrentMediaState.PLAY,
            );
            break;
        case NodePyATVDeviceState.paused:
            this.service?.setCharacteristic(
                this.platform.Characteristic.CurrentMediaState,
                this.platform.Characteristic.CurrentMediaState.PAUSE,
            );
            break;
        case NodePyATVDeviceState.stopped:
            this.service?.setCharacteristic(
                this.platform.Characteristic.CurrentMediaState,
                this.platform.Characteristic.CurrentMediaState.STOP,
            );
            break;
        case NodePyATVDeviceState.loading:
            this.service?.setCharacteristic(
                this.platform.Characteristic.CurrentMediaState,
                this.platform.Characteristic.CurrentMediaState.LOADING,
            );
            break;
        case null:
            this.service?.setCharacteristic(
                this.platform.Characteristic.CurrentMediaState,
                this.platform.Characteristic.CurrentMediaState.INTERRUPTED,
            );
            break;
        }
    }

    private createInputs(apps: NodePyATVApp[]): void {
        const appConfigs = this.getAppConfigs();

        apps.forEach((app) => {
            if (!Object.keys(appConfigs).includes(app.id)) {
                appConfigs[app.id] = {
                    configuredName: app.name,
                    isConfigured: this.platform.Characteristic.IsConfigured.CONFIGURED,
                    visibilityState: HIDE_BY_DEFAULT_APPS.includes(app.id)
                        ? this.platform.Characteristic.CurrentVisibilityState.HIDDEN
                        : this.platform.Characteristic.CurrentVisibilityState.SHOWN,
                    identifier: this.appIdToNumber(app.id),
                };
            }
            this.log.info(`Adding ${appConfigs[app.id].configuredName} (${app.id}) as an input.`);
            const s = this.accessory.getService(app.name) || this.accessory.addService(this.platform.Service.InputSource, app.name, app.id)
                .setCharacteristic(this.platform.Characteristic.ConfiguredName, appConfigs[app.id].configuredName)
                .setCharacteristic(this.platform.Characteristic.InputSourceType, this.platform.Characteristic.InputSourceType.APPLICATION)
                .setCharacteristic(this.platform.Characteristic.IsConfigured, appConfigs[app.id].isConfigured)
                .setCharacteristic(this.platform.Characteristic.Name, app.name)
                .setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, appConfigs[app.id].visibilityState)
                .setCharacteristic(this.platform.Characteristic.InputDeviceType, this.platform.Characteristic.InputDeviceType.OTHER)
                .setCharacteristic(this.platform.Characteristic.TargetVisibilityState, appConfigs[app.id].visibilityState)
                .setCharacteristic(this.platform.Characteristic.Identifier, appConfigs[app.id].identifier);
            s.getCharacteristic(this.platform.Characteristic.ConfiguredName)
                .onSet(async (value) => {
                    if (value === '') {
                        return;
                    }
                    if (appConfigs[app.id].configuredName === value) {
                        return;
                    }
                    this.log.info(`Changing configured name of ${app.id} from ${appConfigs[app.id].configuredName} to ${value}.`);
                    appConfigs[app.id].configuredName = value as string;
                    this.setAppConfigs(appConfigs);
                })
                .onGet(async () => {
                    return appConfigs[app.id].configuredName;
                });
            s.getCharacteristic(this.platform.Characteristic.IsConfigured)
                .onSet(async (value) => {
                    this.log.info(`Changing is configured of ${appConfigs[app.id].configuredName} (${app.id}) from ${appConfigs[app.id].isConfigured} to ${value}.`);
                    appConfigs[app.id].isConfigured = value as 0 | 1;
                    this.setAppConfigs(appConfigs);
                });
            s.getCharacteristic(this.platform.Characteristic.TargetVisibilityState)
                .onSet(async (value) => {
                    this.log.info(`Changing visibility state of ${appConfigs[app.id].configuredName} (${app.id}) from ${appConfigs[app.id].visibilityState} to ${value}.`);
                    appConfigs[app.id].visibilityState = value as 0 | 1;
                    s.setCharacteristic(this.platform.Characteristic.CurrentVisibilityState, value);
                    this.setAppConfigs(appConfigs);
                });
            this.service!.addLinkedService(s);
            this.inputs[app.id] = {
                pyatvApp: app,
                service: s,
            };
        });
        this.setAppConfigs(appConfigs);
    }

    private async handleInputUpdate(event: NodePyATVDeviceEvent): Promise<void> {
        if (event === null) {
            return;
        }
        if (event.value === event.oldValue) {
            return;
        }
        const appId = event.value;
        this.log.info(`Current App: ${appId}`);
        const appConfig = this.getAppConfigs()[appId];
        if (appConfig) {
            const appIdentifier = appConfig.identifier;
            this.setCommonConfig('activeIdentifier', appIdentifier);
            this.service!.setCharacteristic(this.platform.Characteristic.ActiveIdentifier, appIdentifier);
        } else {
            this.log.warn(`Could not update the input to ${appId} since the app is unknown.`);
        }
    }

    private getAppConfigs(): IAppConfigs {
        if (this.appConfigs === undefined) {
            const jsonPath = this.getPath('apps.json');
            this.appConfigs = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as IAppConfigs;
        }
        return this.appConfigs;
    }

    private setAppConfigs(value: IAppConfigs): void {
        this.appConfigs = value;
        const jsonPath = this.getPath('apps.json');
        fs.writeFileSync(jsonPath, JSON.stringify(value, null, 4), { encoding:'utf8', flag:'w' });
    }

    private getCommonConfig(): ICommonConfig {
        if (this.commonConfig === undefined) {
            const jsonPath = this.getPath('common.json');
            this.commonConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as IAppConfigs;
        }
        return this.commonConfig;
    }

    private setCommonConfig(key: string, value: PrimitiveTypes): void {
        if (this.commonConfig === undefined) {
            this.commonConfig = {};
        }
        this.commonConfig[key] = value;
        const jsonPath = this.getPath('common.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.commonConfig, null, 4), { encoding:'utf8', flag:'w' });
    }

    private getMediaConfig(): IMediaConfigs {
        if (this.mediaConfigs === undefined) {
            const jsonPath = this.getPath('mediaTypes.json');
            this.mediaConfigs = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as IMediaConfigs;
        }
        return this.mediaConfigs;
    }

    private setMediaTypeConfig(key: string, value: string): void {
        if (this.mediaConfigs === undefined) {
            this.mediaConfigs = {};
        }
        this.mediaConfigs[key] = value;
        const jsonPath = this.getPath('mediaTypes.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.mediaConfigs, null, 4), { encoding:'utf8', flag:'w' });
    }

    private getDeviceStateConfig(): IStateConfigs {
        if (this.stateConfigs === undefined) {
            const jsonPath = this.getPath('deviceStates.json');
            this.stateConfigs = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as IStateConfigs;
        }
        return this.stateConfigs;
    }

    private setDeviceStateConfig(key: string, value: string): void {
        if (this.stateConfigs === undefined) {
            this.stateConfigs = {};
        }
        this.stateConfigs[key] = value;
        const jsonPath = this.getPath('deviceStates.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.stateConfigs, null, 4), { encoding:'utf8', flag:'w' });
    }

    private async handleActiveGet(): Promise<Nullable<CharacteristicValue>> {
        if (this.offline) {
            throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return this.service!.getCharacteristic(this.platform.Characteristic.Active).value;
    }

    private async handleActiveSet(state: CharacteristicValue): Promise<void> {
        const WAIT_MAX_FOR_STATES = 30; // seconds
        const STEPS = 250; // milliseconds

        if (state === this.platform.Characteristic.Active.ACTIVE && !this.turningOn) {
            this.turningOn = true;
            this.lastOnEvent = Date.now();
            this.log.info('Turning on');
            this.device?.turnOn();
            for (let i = STEPS; i <= WAIT_MAX_FOR_STATES * 1000; i += STEPS) {
                const { mediaType, deviceState } = await this.device.getState();
                if (deviceState === null || mediaType === null) {
                    await delay(STEPS);
                    this.log.debug(`Waiting until mediaType and deviceState is reported: ${i}ms`);
                    continue;
                }
                if (this.mediaTypeServices[mediaType]) {
                    this.log.info(`New Media Type State: ${mediaType}`);
                    this.mediaTypeServices[mediaType].setCharacteristic(this.platform.Characteristic.MotionDetected, true);
                }
                if (this.deviceStateServices[deviceState]) {
                    this.log.info(`New Device State: ${deviceState}`);
                    this.deviceStateServices[deviceState].setCharacteristic(this.platform.Characteristic.MotionDetected, true);
                }
                break;
            }
            this.turningOn = false;
        } else if (state === this.platform.Characteristic.Active.INACTIVE && this.lastOnEvent + 7500 < Date.now()) {
            this.log.info('Turning off');
            this.device?.turnOff();
        }
    }

    private handleActiveUpdate(event: NodePyATVDeviceEvent) {
        if (event.value === null) {
            return;
        }
        if (event.value === event.oldValue) {
            return;
        }
        const value = event.value === 'on' ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        if (value === this.platform.Characteristic.Active.INACTIVE && this.lastOnEvent + 7500 > Date.now()) {
            return;
        }
        this.log.info(`New Active State: ${event.value}`);
        this.service!.setCharacteristic(this.platform.Characteristic.Active, value);
    }

    private async handleActiveIdentifierGet(): Promise<Nullable<CharacteristicValue>> {
        return this.service!.getCharacteristic(this.platform.Characteristic.ActiveIdentifier).value;
    }

    private async handleActiveIdentifierSet(state: CharacteristicValue): Promise<void> {
        const appConfigs = this.getAppConfigs();
        let appId: string | undefined = undefined;
        for (const key in appConfigs) {
            if (appConfigs[key].identifier === state) {
                appId = key;
            }
        }
        if (appId !== undefined) {
            this.setCommonConfig('activeIdentifier', state as number);
            const app = this.inputs[appId];
            this.log.info(`Launching App: ${app.pyatvApp.name}`);
            app.pyatvApp.launch();
        }
    }

    private async handleConfiguredNameGet(): Promise<Nullable<CharacteristicValue>> {
        return this.service!.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
    }

    private async handleConfiguredNameSet(state: CharacteristicValue): Promise<void> {
        if (state === '') {
            return;
        }
        const oldConfiguredName = this.service!.getCharacteristic(this.platform.Characteristic.ConfiguredName).value;
        if (oldConfiguredName === state) {
            return;
        }
        this.log.info(`Changed Configured Name from ${oldConfiguredName} to ${state}`);
        this.setCommonConfig('configuredName', state as string);
        this.log.setAppleTVName(state as string);
    }

    private async handleSleepDiscoveryModeGet(): Promise<Nullable<CharacteristicValue>> {
        return this.service!.getCharacteristic(this.platform.Characteristic.SleepDiscoveryMode).value;
    }

    private async handleRemoteKeySet(state: CharacteristicValue): Promise<void> {
        switch (state) {
        case this.platform.Characteristic.RemoteKey.REWIND:
            this.log.info('remote rewind');
            this.device.skipBackward();
            break;
        case this.platform.Characteristic.RemoteKey.FAST_FORWARD:
            this.log.info('remote fast forward');
            this.device.skipForward();
            break;
        case this.platform.Characteristic.RemoteKey.NEXT_TRACK:
            this.log.info('remote next rack');
            this.device.next();
            break;
        case this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK:
            this.log.info('remote previous track');
            this.device.previous();
            break;
        case this.platform.Characteristic.RemoteKey.ARROW_UP:
            this.log.info('remote arrow up');
            this.device.up();
            break;
        case this.platform.Characteristic.RemoteKey.ARROW_DOWN:
            this.log.info('remote arrow down');
            this.device.down();
            break;
        case this.platform.Characteristic.RemoteKey.ARROW_LEFT:
            this.log.info('remote arrow left');
            this.device.left();
            break;
        case this.platform.Characteristic.RemoteKey.ARROW_RIGHT:
            this.log.info('remote arrow right');
            this.device.right();
            break;
        case this.platform.Characteristic.RemoteKey.SELECT:
            this.log.info('remote select');
            this.device.select();
            break;
        case this.platform.Characteristic.RemoteKey.BACK:
            this.log.info('remote back');
            this.device.menu();
            break;
        case this.platform.Characteristic.RemoteKey.EXIT:
            this.log.info('remote exit');
            this.device.home();
            break;
        case this.platform.Characteristic.RemoteKey.PLAY_PAUSE:
            this.log.info('remote play/pause');
            this.device.playPause();
            break;
        case this.platform.Characteristic.RemoteKey.INFORMATION:
            this.log.info('remote information');
            this.device.topMenu();
            break;
        }
    }

    private appIdToNumber(appId: string): number {
        const hash = new Uint8Array(md5(appId, { asBytes: true }));
        const view = new DataView(hash.buffer);
        return view.getUint32(0);
    }

    private getPath(file: string, defaultContent = '{}'): string {
        let dir = path.join(this.platform.api.user.storagePath(), 'appletv-enhanced');
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        dir += `/${this.device.id!.replaceAll(':', '')}`;
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        const filePath = path.join(dir, file);
        try {
            fs.writeFileSync(filePath, defaultContent, { encoding:'utf8', flag: 'wx' });
        } catch (err) { /* empty */ }
        return filePath;
    }

    private getCredentials(): string {
        const path = this.getPath('credentials.txt', '');
        const credentials = fs.readFileSync(path, 'utf8').trim();
        this.log.debug(`Loaded credentials: ${credentials}`);
        return credentials;
    }

    private saveCredentials(credentials: string): void {
        const path = this.getPath('credentials.txt', '');
        fs.writeFileSync(path, credentials, { encoding:'utf8', flag:'w' });
    }

    private async pair(ip: string, appleTVName: string): Promise<string> {
        this.log.debug('Got empty credentials, initiating pairing process.');

        const ipSplitted = ip.split('.');
        const ipEnd = ipSplitted[ipSplitted.length - 1];
        const httpPort = 42000 + parseInt(ipEnd);

        const htmlInput = fs.readFileSync(path.join(__dirname, 'html', 'input.html'), 'utf8');
        const htmlAfterPost = fs.readFileSync(path.join(__dirname, 'html', 'afterPost.html'), 'utf8');

        let goOn = false;
        let success = false;

        const localIP = getLocalIP();
        let credentials = '';

        while (!success) {
            let backOffSeconds = 0;
            let processClosed = false;

            const process = spawn(CustomPyAtvInstance.getAtvremotePath(), ['-s', ip, '--protocol', 'companion', 'pair']);
            process.stderr.setEncoding('utf8');
            process.stderr.on('data', (data: string) => {
                this.log.error('stderr: ' + data);
                goOn = true;
            });
            process.stdout.setEncoding('utf8');
            process.stdout.on('data', (data: string) => {
                this.log.debug('stdout: ' + data);
                if (data.includes('Enter PIN on screen:')) {
                    return;
                }
                if (data.includes('BackOff=')) {
                    backOffSeconds = parseInt(data.substring(data.search('BackOff=') + 8).split('s', 2)[0]) + 5;
                    goOn = true;
                    return;
                }
                if (data.toUpperCase().includes('ERROR')) {
                    goOn = true;
                    return;
                }
                if (data.includes('You may now use these credentials: ')) {
                    const split = data.split(': ');
                    credentials = split[1].trim();
                    this.log.debug(`Extracted credentials: ${split[1]}`);
                    goOn = true;
                    success = true;
                }
            });
            process.on('close', () => {
                processClosed = true;
            });

            setTimeout(() => {
                if (!processClosed) {
                    this.log.warn('Pairing request timed out, retrying ...');
                    this.log.debug('Send \\n to the stdout of the atvremote process to terminate it.');
                    process.stdin.write('\n');
                }
            }, 32000);

            const requestListener = (req: IncomingMessage, res: ServerResponse<IncomingMessage> & { req: IncomingMessage }): void => {
                res.setHeader('Content-Security-Policy', 'default-src * \'self\' data: \'unsafe-inline\' \'unsafe-hashes\' \'unsafe-eval\';\
                script-src * \'self\' data: \'unsafe-inline\' \'unsafe-hashes\' \'unsafe-eval\';\
                script-src-elem * \'self\' data: \'unsafe-inline\' \'unsafe-hashes\' \'unsafe-eval\';\
                script-src-attr * \'self\' data: \'unsafe-inline\' \'unsafe-hashes\' \'unsafe-eval\';\
                media-src * \'self\'');
                res.setHeader('Cache-Control', 'max-age=0, no-cache, must-revalidate, proxy-revalidate');
                res.writeHead(200);
                if (req.method === 'GET') {
                    res.end(htmlInput);
                } else {
                    let reqBody = '';
                    req.on('data', (chunk) => {
                        reqBody += chunk;
                    });
                    req.on('end', () => {
                        const [a, b, c, d] = reqBody.split('&').map((e) => e.charAt(2));
                        const pin = `${a}${b}${c}${d}`;
                        this.log.info(`Got PIN ${pin} for Apple TV ${appleTVName}.`);
                        process.stdin.write(`${pin}\n`);
                        res.end(htmlAfterPost);
                    });
                }
            };
            const server = http.createServer(requestListener);
            server.listen(httpPort, '0.0.0.0', () => {
                // eslint-disable-next-line max-len
                this.log.warn(`You need to pair your Apple TV before the plugin can connect to it. Enter the PIN that is currently displayed on the device here: http://${localIP}:${httpPort}/`);
            });

            this.log.debug('Wait for the atvremote process to terminate');
            while (!goOn || !processClosed) {
                await delay(100);
            }
            server.close();

            if (backOffSeconds !== 0) {
                this.log.warn(`Apple TV ${appleTVName}: Too many attempts. Waiting for ${backOffSeconds} seconds before retrying.`);
                for (; backOffSeconds > 0; backOffSeconds--) {
                    this.log.debug(`${backOffSeconds} seconds remaining.`);
                    await delay(1000);
                }
            }
        }

        return credentials;
    }

    public async untilBooted(): Promise<void> {
        while (!this.booted) {
            await delay(100);
        }
        this.log.debug('Reporting as booted.');
    }
}
