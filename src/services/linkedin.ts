import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { LINKEDIN_API_BASE, LINKEDIN_REST_BASE, LINKEDIN_VERSION } from "../constants.js";

// Retrieve access token from environment
function getAccessToken(): string {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "LINKEDIN_ACCESS_TOKEN environment variable is not set. " +
      "Please obtain an OAuth 2.0 access token from https://developer.linkedin.com and set it."
    );
  }
  return token;
}

// Base headers for v2 API
function v2Headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAccessToken()}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Base headers for REST API (newer endpoints like /rest/posts)
function restHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAccessToken()}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// Generic request helper for v2 API
export async function v2Request<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, unknown>
): Promise<T> {
  const config: AxiosRequestConfig = {
    method,
    url: `${LINKEDIN_API_BASE}/${endpoint}`,
    headers: v2Headers(),
    timeout: 30000,
  };
  if (data) config.data = data;
  if (params) config.params = params;

  const response = await axios(config);
  return response.data as T;
}

// Generic request helper for REST API
export async function restRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, unknown>
): Promise<{ data: T; headers: Record<string, string> }> {
  const config: AxiosRequestConfig = {
    method,
    url: `${LINKEDIN_REST_BASE}/${endpoint}`,
    headers: restHeaders(),
    timeout: 30000,
  };
  if (data) config.data = data;
  if (params) config.params = params;

  const response = await axios(config);
  return { data: response.data as T, headers: response.headers as Record<string, string> };
}

// Actionable error messages
export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const body = axiosErr.response.data as Record<string, unknown> | undefined;
      const detail = body?.message ?? body?.serviceErrorCode ?? "";
      switch (status) {
        case 401:
          return (
            "Error: Unauthorized. Your access token is invalid or expired. " +
            "Please refresh your LINKEDIN_ACCESS_TOKEN."
          );
        case 403:
          return (
            "Error: Permission denied. You may be missing required OAuth scopes. " +
            `Required scopes depend on the action. Detail: ${detail}`
          );
        case 404:
          return "Error: Resource not found. Please verify the URN or ID is correct.";
        case 422:
          return `Error: Unprocessable entity. ${detail || "Check the request body fields."}`;
        case 429:
          return "Error: Rate limit exceeded. LinkedIn allows ~100-500 calls/day. Please wait before retrying.";
        default:
          return `Error: LinkedIn API returned ${status}. ${detail}`;
      }
    } else if (axiosErr.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

// Upload image bytes to LinkedIn and return the image URN
export async function uploadImage(personUrn: string, imageBuffer: Buffer, mimeType: string): Promise<string> {
  // Step 1: Initialize upload
  const initPayload = {
    initializeUploadRequest: {
      owner: personUrn,
    },
  };
  const initRes = await restRequest<{
    value: { uploadUrl: string; image: string };
  }>("images?action=initializeUpload", "POST", initPayload);

  const { uploadUrl, image: imageUrn } = initRes.data.value;

  // Step 2: Upload binary to the pre-signed URL
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "Content-Type": mimeType,
    },
    timeout: 60000,
  });

  return imageUrn;
}
