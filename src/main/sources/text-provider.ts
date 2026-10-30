import type {
  RemoteLibraryInfo,
  TextBookDetail,
  TextBrowsePage,
  TextBrowseRequest,
  TextImportRequest,
  TextDetailRequest,
  TextSourceInfo,
} from '../../shared/text-sources'
import type { TextHttpClient } from './text-http'

/** Main-process-only connection. Never serialize this value to a renderer or log. */
export interface StoredRemoteLibrary extends RemoteLibraryInfo {
  username?: string
  password?: string
  token?: string
}

export interface TextLibraryContext {
  connection: StoredRemoteLibrary
  http: TextHttpClient
  signal: AbortSignal
}

export interface TextDownload {
  bytes: Buffer
  filename: string
}

export interface TextLibraryConnector {
  browse(context: TextLibraryContext, request: TextBrowseRequest): Promise<TextBrowsePage>
  detail(context: TextLibraryContext, workId: string): Promise<TextBookDetail>
  download(context: TextLibraryContext, request: TextImportRequest): Promise<TextDownload>
}

export interface PluginTextSources {
  sources(): TextSourceInfo[]
  browse(request: TextBrowseRequest, signal: AbortSignal): Promise<TextBrowsePage>
  detail(request: TextDetailRequest, signal: AbortSignal): Promise<TextBookDetail>
  download(request: TextImportRequest, signal: AbortSignal): Promise<TextDownload>
}
