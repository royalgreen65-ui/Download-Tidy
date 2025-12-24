
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
}
