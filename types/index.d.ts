declare module 'gymnasticon' {
  export interface BikeMetrics {
    power: number;
    cadence: number;
    resistance?: number;
  }

  export interface BikeClient {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    on(event: 'data' | 'stats' | 'disconnect', callback: Function): void;
  }
}
