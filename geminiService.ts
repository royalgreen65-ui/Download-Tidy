
import { GoogleGenAI, Type } from "@google/genai";
import { FileCategory } from "./types";

// Helper function to categorize files using Gemini API
export const categorizeFiles = async (fileNames: string[]): Promise<Record<string, FileCategory>> => {
  // Always create a new GoogleGenAI instance right before making an API call
  // Use process.env.API_KEY directly as required.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Categorize the following list of file names into one of these categories: 
      ${Object.values(FileCategory).join(', ')}. 
      Return an array of objects for each file.
      
      Files: ${fileNames.join(', ')}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fileName: {
                type: Type.STRING,
                description: "The original name of the file to be categorized."
              },
              category: {
                type: Type.STRING,
                enum: Object.values(FileCategory),
                description: "The category that best fits the file."
              },
            },
            required: ["fileName", "category"],
          },
        },
      },
    });

    const result: Record<string, FileCategory> = {};
    const text = response.text;
    
    if (!text) {
      return fallbackCategorization(fileNames);
    }

    try {
      const data = JSON.parse(text.trim());
      if (Array.isArray(data)) {
        data.forEach((item: any) => {
          if (item.fileName && item.category) {
            result[item.fileName] = item.category as FileCategory;
          }
        });
      }
    } catch (parseError) {
      console.error("JSON Parse Error:", parseError);
    }
    
    // Ensure all requested files have a category, using fallback for missing ones
    fileNames.forEach(name => {
      if (!result[name]) {
        const fallback = fallbackCategorization([name]);
        result[name] = fallback[name];
      }
    });

    return result;
  } catch (error) {
    console.error("Gemini Error:", error);
    return fallbackCategorization(fileNames);
  }
};

// Local fallback categorization based on file extensions
const fallbackCategorization = (fileNames: string[]): Record<string, FileCategory> => {
  const mapping: Record<string, FileCategory> = {};
  const extensions: Record<string, FileCategory> = {
    pdf: FileCategory.DOCUMENTS, docx: FileCategory.DOCUMENTS, txt: FileCategory.DOCUMENTS,
    jpg: FileCategory.IMAGES, png: FileCategory.IMAGES, gif: FileCategory.IMAGES, svg: FileCategory.IMAGES,
    mp4: FileCategory.VIDEOS, mov: FileCategory.VIDEOS, mkv: FileCategory.VIDEOS,
    zip: FileCategory.ARCHIVES, rar: FileCategory.ARCHIVES, tar: FileCategory.ARCHIVES,
    exe: FileCategory.INSTALLERS, dmg: FileCategory.INSTALLERS, pkg: FileCategory.INSTALLERS,
    js: FileCategory.CODE, ts: FileCategory.CODE, py: FileCategory.CODE, html: FileCategory.CODE,
    mp3: FileCategory.AUDIO, wav: FileCategory.AUDIO, flac: FileCategory.AUDIO
  };

  fileNames.forEach(name => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    mapping[name] = extensions[ext] || FileCategory.UNKNOWN;
  });

  return mapping;
};
