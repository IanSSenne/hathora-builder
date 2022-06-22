import { Reader, Writer } from "bin-serde";
import net from "net";
import { COORDINATOR_HOST } from "../../api/base";
import WebSocket from "isomorphic-ws";

export enum TransportType {
  WebSocket,
  TCP,
  UDP,
}

export interface HathoraTransport {
  connect(
    stateId: string,
    token: string,
    onData: (data: Buffer) => void,
    onClose: (e: { code: number; reason: string }) => void
  ): Promise<void>;
  disconnect(code?: number): void;
  pong(): void;
  isReady(): boolean;
  write(data: Uint8Array): void;
}

export class WebSocketHathoraTransport implements HathoraTransport {
  private socket: WebSocket;

  constructor(private appId: string) {
    this.socket = new WebSocket(`wss://${COORDINATOR_HOST}/${appId}`);
  }

  public connect(
    stateId: string,
    token: string,
    onData: (data: Buffer) => void,
    onClose: (e: { code: number; reason: string }) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.binaryType = "arraybuffer";
      this.socket.onclose = onClose;
      this.socket.onopen = () =>
        this.socket.send(
          new Writer()
            .writeUInt8(0)
            .writeString(token)
            .writeUInt64([...stateId].reduce((r, v) => r * 36n + BigInt(parseInt(v, 36)), 0n))
            .toBuffer()
        );
      this.socket.onmessage = ({ data }) => {
        const reader = new Reader(new Uint8Array(data as ArrayBuffer));
        const type = reader.readUInt8();
        if (type === 0) {
          this.socket.onmessage = ({ data }) => onData(data as Buffer);
          this.socket.onclose = onClose;
          onData(data as Buffer);
          resolve();
        } else {
          reject("Unexpected message type: " + type);
        }
      };
    });
  }

  public disconnect(code?: number | undefined): void {
    if (code === undefined) {
      this.socket.onclose = () => {};
    }
    this.socket.close(code);
  }

  public isReady(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  public write(data: Uint8Array): void {
    this.socket.send(data);
  }

  public pong() {
    this.socket.ping();
  }
}

export class TCPHathoraTransport implements HathoraTransport {
  private socket: net.Socket;

  constructor(private appId: string) {
    this.socket = new net.Socket();
  }

  public connect(
    stateId: string,
    token: string,
    onData: (data: Buffer) => void,
    onClose: (e: { code: number; reason: string }) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(7148, COORDINATOR_HOST);
      this.socket.on("connect", () =>
        this.socket.write(
          new Writer()
            .writeString(token)
            .writeString(this.appId)
            .writeUInt64([...stateId].reduce((r, v) => r * 36n + BigInt(parseInt(v, 36)), 0n))
            .toBuffer()
        )
      );
      this.socket.once("data", (data: Buffer) => {
        const reader = new Reader(new Uint8Array(data as ArrayBuffer));
        const type = reader.readUInt8();
        if (type === 0) {
          this.readTCPData(onData);
          this.socket.on("close", onClose);
          onData(data as Buffer);
          resolve();
        } else {
          reject("Unknown message type: " + type);
        }
      });
    });
  }

  public write(data: Uint8Array) {
    this.socket.write(
      new Writer()
        .writeUInt32(data.length + 1)
        .writeUInt8(0)
        .writeBuffer(data)
        .toBuffer()
    );
  }

  public disconnect(code?: number | undefined): void {
    this.socket.destroy();
  }

  public isReady(): boolean {
    return this.socket.readyState === "open";
  }

  public pong(): void {
    this.socket.write(new Writer().writeUInt32(1).writeUInt8(1).toBuffer());
  }

  private readTCPData(onData: (data: Buffer) => void) {
    let buf = Buffer.alloc(0);
    this.socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4) {
        const bufLen = buf.readUInt32BE();
        if (buf.length < 4 + bufLen) {
          return;
        }
        onData(buf.slice(4, 4 + bufLen));
        buf = buf.slice(4 + bufLen);
      }
    });
  }
}