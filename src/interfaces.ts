import { Service } from 'homebridge';

export interface NodePyATVApp {
    id: string;
    name: string;
    launch: () => Promise<void>;
}

export interface IInput {
    pyatvApp: NodePyATVApp;
    service: Service;
}


export interface IInputs {
    [k: string]: IInput;
}

export interface IAppConfig {
    configuredName: string;
    isConfigured: 0 | 1;
    visibilityState: 0 | 1;
    identifier: number;
}

export interface IAppConfigs {
    [k: string]: IAppConfig;
}

export interface ICommonConfig {
    configuredName?: string;
    activeIdentifier?: number;
}

export interface IMediaConfigs {
    [k: string]: string;
}

export interface IStateConfigs {
    [k: string]: string;
}