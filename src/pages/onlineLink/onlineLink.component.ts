import {ChangeDetectorRef, Component, inject, ViewChild} from '@angular/core';
import { NgClass, NgIf } from '@angular/common';
import {FormsModule} from '@angular/forms';

import {CommandType, FirmwareVersion} from '../../shared/linkExchange/common';

import {Subscription} from 'rxjs';
import {PlayerSessionService} from '../../services/playersession.service';
import {WebSocketService} from '../../services/websocket.service';
import {LinkExchangeSession} from '../../shared/linkExchange/linkExchangeSession';
import {ToastComponent} from '../../component/toast.component';
import {LinkDeviceUtils} from '../../shared/linkDeviceUtils';
import {CommandEmitterSocketIO} from '../../shared/linkExchange/commandEmitter/commandEmitter.socketIO';
import {LinkDeviceService} from '../../services/linkdevice.service';
import {StatusEmitterLinkDevice} from '../../shared/linkExchange/statusEmitter/statusEmitter.linkDevice';
import {CelioPageAbstract} from '../shared/celioPage.abstact';

enum StepsState {
  ConnectingCelioDevice = 0,
  JoiningSession = 1,
  Lobby = 2,
  Ready = 3
}

// 3-4 player links need firmware with the multiplayer link mode.
const MULTIPLAYER_FIRMWARE: FirmwareVersion = { major: 2, minor: 2, patch: 4 };

@Component({
  selector: 'app-onlineLink',
  standalone: true,
  imports: [
    NgIf,
    NgClass,
    FormsModule,
    ToastComponent
  ],
  templateUrl: './onlineLink.component.html'
})

export class OnlineLinkComponent extends CelioPageAbstract<StepsState>{

  @ViewChild(ToastComponent) toast!: ToastComponent;

  private linkDeviceService = inject(LinkDeviceService)

  protected StepsState = StepsState;
  protected sessionId = "";
  protected joinId = "";
  protected isHost = false;
  protected seat = 0;
  protected playerCount = 0;
  protected playersJoined = 1;
  protected starting = false;
  protected supportsMultiplayer = false;

  private subs = new Subscription();
  private relaySubs: Subscription | undefined;
  private linkSession: LinkExchangeSession | undefined;
  private linkStarted = false;
  private startEpoch = 0;

  constructor(private cdr: ChangeDetectorRef,
              private playerSessionService: PlayerSessionService,
              private socket: WebSocketService) {
    super(cdr);
    this.stepState = StepsState.ConnectingCelioDevice;

    this.subs.add(this.linkDeviceService.disconnectEvents$.subscribe(() => {
      this.teardown();
      this.sessionId = "";
      this.advanceLinkState(StepsState.ConnectingCelioDevice);
    }));

    this.subs.add(this.playerSessionService.partnerEvents$.subscribe(joined => {
      if (joined) {
        this.playersJoined++;
      } else {
        if (this.playersJoined > 1) this.playersJoined--;
        this.toast.show("A player has left");
      }
      cdr.detectChanges();
    }));

    this.subs.add(this.playerSessionService.sessionClose$.subscribe(() => {
      this.toast.show("Session has ended");
      this.teardown();
      this.sessionId = "";
      this.advanceLinkState(StepsState.JoiningSession);
    }));
  }

  ngOnInit() {
    if (this.linkDeviceService.isConnected()) {
      this.queryMultiplayerSupport().then(() => this.cdr.detectChanges());
      this.advanceLinkState(StepsState.JoiningSession);
    }
  }

  ngOnDestroy() {
    this.teardown();
    this.subs.unsubscribe();
  }

  connect(kind: 'usb' | 'serial' = 'usb'): void {
    if (kind === 'usb' ? !this.usbSupported : !this.serialSupported) return;

    this.linkDeviceService.connectDevice(kind).then(async isConnected => {
      if (!isConnected) return;
      await this.queryMultiplayerSupport();
      this.advanceLinkState(StepsState.JoiningSession);
    });
  }

  private async queryMultiplayerSupport() {
    const version = await LinkDeviceUtils.getFirmwareVersion(this.linkDeviceService);
    this.supportsMultiplayer = version !== undefined && this.versionAtLeast(version, MULTIPLAYER_FIRMWARE);
  }

  private versionAtLeast(version: FirmwareVersion, required: FirmwareVersion): boolean {
    if (version.major !== required.major) return version.major > required.major;
    if (version.minor !== required.minor) return version.minor > required.minor;
    return version.patch >= required.patch;
  }

  protected get maxPlayers(): number {
    return this.supportsMultiplayer ? 4 : 2;
  }

  async enterSession(userSessionId?: string) {
    if (!await this.socket.connect()) {
      this.toast.show("Could not connect to Server", 'error', 4000);
      return;
    }
    try {
      const session = await this.playerSessionService.enterSession(userSessionId);
      this.sessionId = session.id;
      this.seat = session.seat ?? 0;
      this.isHost = !userSessionId;
      this.playersJoined = this.seat + 1;
      if (this.isHost && this.supportsMultiplayer) this.socket.emit("setRoomSize", 4);
      this.listenForStart();
      this.advanceLinkState(StepsState.Lobby);
    } catch (error: any) {
      this.toast.show(String(error), 'error', 4000);
      this.socket.disconnect();
      this.advanceLinkState(StepsState.JoiningSession);
    }
  }

  // Host: ask the server to start; it broadcasts each client's seat and the
  // player count. With exactly 2 players either side may start instead, since
  // an Emulator-tab partner has no start broadcast of its own.
  startGame() {
    if (this.starting || this.linkStarted) return;

    if (!this.isHost) {
      this.starting = true;
      this.startTwoPlayerLink();
      return;
    }

    if (!this.socket.isConnected()) {
      this.toast.show("Not connected to server", 'error', 4000);
      return;
    }
    this.starting = true;
    this.socket.emit("multiLinkStart");
    setTimeout(() => {
      if (!this.linkStarted && this.starting) {
        this.starting = false;
        this.toast.show("Server did not start the session, try again", 'error', 4000);
        this.cdr.detectChanges();
      }
    }, 5000);
  }

  private listenForStart() {
    this.relaySubs?.unsubscribe();
    this.relaySubs = new Subscription();
    this.relaySubs.add(
      this.socket.fromEvent<{ seat: number, playerCount: number }>("multiLinkStart").subscribe(info => {
        if (this.linkStarted) return;
        this.seat = info.seat;
        this.playerCount = info.playerCount;
        if (info.playerCount >= 3) {
          if (!this.supportsMultiplayer) {
            this.toast.show("Adapter firmware 2.2.4 or newer is required for 3-4 players", 'error', 6000);
            return;
          }
          this.linkStarted = true;
          this.startMultiplayerLink();
        } else {
          this.startTwoPlayerLink();
        }
      })
    );
  }

  // 2 players use the server-coordinated link, which also interoperates with
  // the Emulator tabs.
  private startTwoPlayerLink() {
    if (this.linkStarted) return;
    this.linkStarted = true;
    this.playerCount = 2;
    const epoch = this.startEpoch;
    LinkDeviceUtils.tryEnableLinkMode(new StatusEmitterLinkDevice(this.linkDeviceService))
      .then(() => {
        if (epoch !== this.startEpoch) {
          this.linkDeviceService.sendCommand(CommandType.Cancel);
          return;
        }
        this.linkSession?.destroy();
        this.linkSession = new LinkExchangeSession(
          new CommandEmitterSocketIO(this.socket),
          new StatusEmitterLinkDevice(this.linkDeviceService));
        this.advanceLinkState(StepsState.Ready);
      })
      .catch(error => this.startFailed(epoch, error));
  }

  // 3-4 players: the firmware links the seats directly and the page relays
  // its seat-tagged frames between the adapter and the server.
  private startMultiplayerLink() {
    const epoch = this.startEpoch;
    LinkDeviceUtils.tryEnableOnlineLink(new StatusEmitterLinkDevice(this.linkDeviceService), this.seat, this.playerCount)
      .then(() => {
        if (epoch !== this.startEpoch) {
          this.linkDeviceService.sendCommand(CommandType.Cancel);
          return;
        }
        this.setupRelay();
        this.advanceLinkState(StepsState.Ready);
      })
      .catch(error => this.startFailed(epoch, error));
  }

  private startFailed(epoch: number, error: any) {
    if (epoch !== this.startEpoch) return;
    this.toast.show(String(error), 'error', 4000);
    this.linkStarted = false;
    this.starting = false;
    this.cdr.detectChanges();
  }

  private setupRelay() {
    this.relaySubs?.add(this.linkDeviceService.dataRawEvents$.subscribe(bytes => {
      if (!bytes || bytes.length < 2) return;
      if (bytes[0] >= 0xA0 && bytes[0] <= 0xAF) this.socket.emit("relayData", Array.from(bytes));
    }));
    this.relaySubs?.add(this.socket.fromEvent<number[]>("relayData").subscribe(data => {
      if (data && data.length >= 2) this.linkDeviceService.sendDataRaw(new Uint8Array(data));
    }));
  }

  private teardown() {
    this.startEpoch++;
    this.relaySubs?.unsubscribe();
    this.relaySubs = undefined;
    this.linkSession?.destroy();
    this.linkSession = undefined;
    this.playerSessionService.leaveSession();
    this.socket.disconnect();
    if (this.linkDeviceService.isConnected()) this.linkDeviceService.sendCommand(CommandType.Cancel);
    this.playerCount = 0;
    this.playersJoined = 1;
    this.isHost = false;
    this.linkStarted = false;
    this.starting = false;
  }

  leaveSession() {
    this.teardown();
    this.sessionId = "";
    this.advanceLinkState(StepsState.JoiningSession);
  }

  disconnectCelioDevice(): void {
    this.leaveSession();
  }

  copySessionId() {
    navigator.clipboard.writeText(this.sessionId);
    this.toast.show("Session Id copied", 'info', 1800);
  }
}
