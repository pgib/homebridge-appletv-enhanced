import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { RemoteControlCommands } from './enums';
import PrefixLogger from './PrefixLogger';
import { Logger } from 'homebridge';

class RocketRemote {

    private process?: ChildProcessWithoutNullStreams = undefined;
    private readonly log: PrefixLogger;
    private onCloseCallable?: (() => void) = undefined;
    private heartbeatInterval?: NodeJS.Timeout;

    constructor(
        private readonly mac: string,
        private readonly atvremotePath: string,
        private readonly airplayCredentials: string,
        private readonly companionCredentials: string,
        logger: Logger | PrefixLogger,
    ) {
        this.log = new PrefixLogger(logger, 'Rocket Remote');
        this.initProcess();
    }

    private initProcess() {
        this.log.debug('creating');

        this.process = spawn(this.atvremotePath, [
            '--id', this.mac,
            '--companion-credentials', this.companionCredentials,
            '--airplay-credentials', this.airplayCredentials,
            'cli',
        ]);
        this.process.stdout.setEncoding('utf8');
        this.process.stderr.setEncoding('utf8');

        this.initHeartbeat();
    }

    private initHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            this.log.debug('heartbeat');
            this.process?.stdin.write('app_list\n');
        }, 15000);
    }

    public sendCommand(cmd: RemoteControlCommands): void {
        this.log.info(cmd);
        this.process?.stdin.write(`${cmd}\n`);
    }

    public channelDown(): void {
        this.sendCommand(RemoteControlCommands.CHANNEL_DOWN);
    }

    public channelUp(): void {
        this.sendCommand(RemoteControlCommands.CHANNEL_UP);
    }

    public down(): void {
        this.sendCommand(RemoteControlCommands.DOWN);
    }

    public home(): void {
        this.sendCommand(RemoteControlCommands.HOME);
    }

    public homeHold(): void {
        this.sendCommand(RemoteControlCommands.HOME_HOLD);
    }

    public left(): void {
        this.sendCommand(RemoteControlCommands.LEFT);
    }

    public menu(): void {
        this.sendCommand(RemoteControlCommands.MENU);
    }

    public next(): void {
        this.sendCommand(RemoteControlCommands.NEXT);
    }

    public pause(): void {
        this.sendCommand(RemoteControlCommands.PAUSE);
    }

    public play(): void {
        this.sendCommand(RemoteControlCommands.PLAY);
    }

    public playPause(): void {
        this.sendCommand(RemoteControlCommands.PLAY_PAUSE);
    }

    public previous(): void {
        this.sendCommand(RemoteControlCommands.PREVIOUS);
    }

    public right(): void {
        this.sendCommand(RemoteControlCommands.RIGHT);
    }

    public select(): void {
        this.sendCommand(RemoteControlCommands.SELECT);
    }

    public skipBackward(): void {
        this.sendCommand(RemoteControlCommands.SKIP_BACKWARD);
    }

    public skipForward(): void {
        this.sendCommand(RemoteControlCommands.SKIP_FORWARD);
    }

    public stop(): void {
        this.sendCommand(RemoteControlCommands.STOP);
    }

    public turnOff(): void {
        this.sendCommand(RemoteControlCommands.TURN_OFF);
    }

    public turnOn(): void {
        this.sendCommand(RemoteControlCommands.TURN_ON);
    }

    public topMenu(): void {
        this.sendCommand(RemoteControlCommands.TOP_MENU);
    }

    public up(): void {
        this.sendCommand(RemoteControlCommands.UP);
    }

    public onClose(f: () => void): void {
        this.onCloseCallable = f;
        this.process?.once('close', () => {
            this.process?.stdout.removeAllListeners();
            this.process?.stderr.removeAllListeners();
            clearInterval(this.heartbeatInterval);
            this.log.warn('Lost connection. Trying to reconnect ...');
            this.onCloseCallable && this.onCloseCallable();
        });
    }
}

export default RocketRemote;