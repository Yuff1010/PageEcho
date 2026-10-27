declare module 'unzipper' {
  import type { Readable } from 'node:stream'
  export interface CentralEntry {
    path: string
    pathBuffer: Buffer
    flags: number
    compressionMethod: number
    compressedSize: number
    uncompressedSize: number
    offsetToLocalFileHeader: number
    externalFileAttributes: number
    crc32: number
    type: 'File' | 'Directory'
  }
  export const Open: {
    custom(
      source: { size(): Promise<number>; stream(offset: number, length?: number): Readable },
      options?: { tailSize?: number },
    ): Promise<{ files: CentralEntry[] }>
  }
}
