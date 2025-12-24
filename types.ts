
export enum FileCategory {
  DOCUMENTS = 'Documents',
  IMAGES = 'Images',
  VIDEOS = 'Videos',
  ARCHIVES = 'Archives',
  INSTALLERS = 'Installers',
  CODE = 'Code',
  AUDIO = 'Audio',
  UNKNOWN = 'Unknown',
  JUNK = 'Junk'
}

export interface FileMetadata {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  lastModified: number;
  extension: string;
  suggestedCategory: FileCategory;
  handle: FileSystemHandle;
  isDuplicate?: boolean;
  duplicateGroupId?: string;
  path: string; // Relative path from the root directory
}

export interface FolderMetadata {
  name: string;
  path: string;
  handle: FileSystemDirectoryHandle;
  fileCount: number;
  subFolderCount: number;
  willBeEmpty: boolean; // True if all contained files are selected for moving
}

export interface DuplicateGroup {
  id: string;
  files: FileMetadata[];
  resolved: boolean;
}

export interface UndoRecord {
  fileName: string;
  originalRelativePath: string; // e.g., "work/docs/report.pdf"
  category: FileCategory;
}

export interface FolderUndoRecord {
  path: string;
  name: string;
}

export interface CustomRule {
  id: string;
  type: 'extension' | 'keyword';
  pattern: string;
  category: FileCategory;
}

export interface SortingRule {
  extension: string;
  category: FileCategory;
}

export interface ProcessingState {
  isScanning: boolean;
  isOrganizing: boolean;
  error: string | null;
  progress: number;
  activity?: string;
  currentFileName?: string;
}
