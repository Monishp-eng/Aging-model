import ms from "ms";
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const timeAgo = (timestamp: Date, timeOnly?: boolean): string => {
  if (!timestamp) return "never";
  return `${ms(Date.now() - new Date(timestamp).getTime())}${
    timeOnly ? "" : " ago"
  }`;
};

export async function fetcher<JSON = any>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<JSON> {
  const res = await fetch(input, init);

  if (!res.ok) {
    const json = await res.json();
    if (json.error) {
      const error = new Error(json.error) as Error & {
        status: number;
      };
      error.status = res.status;
      throw error;
    } else {
      throw new Error("An unexpected error occurred");
    }
  }

  return res.json();
}

export function nFormatter(num: number, digits?: number) {
  if (!num) return "0";
  const lookup = [
    { value: 1, symbol: "" },
    { value: 1e3, symbol: "K" },
    { value: 1e6, symbol: "M" },
    { value: 1e9, symbol: "G" },
    { value: 1e12, symbol: "T" },
    { value: 1e15, symbol: "P" },
    { value: 1e18, symbol: "E" },
  ];
  const rx = /\.0+$|(\.[0-9]*[1-9])0+$/;
  var item = lookup
    .slice()
    .reverse()
    .find(function (item) {
      return num >= item.value;
    });
  return item
    ? (num / item.value).toFixed(digits || 1).replace(rx, "$1") + item.symbol
    : "0";
}

export function capitalize(str: string) {
  if (!str || typeof str !== "string") return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export const truncate = (str: string, length: number) => {
  if (!str || str.length <= length) return str;
  return `${str.slice(0, length)}...`;
};

export const getURL = (input: string = ""): string => {
  // If running in browser and window.location is defined, use current window origin
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${input}`;
  }

  // Fallback to canonical environment URL resolution
  const env = process.env.NEXT_PUBLIC_VERCEL_ENV;
  let base = "http://localhost:3000";
  if (process.env.NEXT_PUBLIC_APP_URL) {
    base = process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  } else if (env === "production" && process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL) {
    base = `https://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`;
  } else if (env === "preview" && process.env.NEXT_PUBLIC_VERCEL_URL) {
    base = `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
  }

  return `${base}${input}`;
};

// Returns domain for callbacks and redirects with safe fallback for local development
export const getDomain = (input: string = ""): string => {
  // Check if we are running in a Node.js server context with access to full configuration
  if (typeof window === "undefined") {
    try {
      const { getServerConfig } = require("@/lib/config/server");
      const config = getServerConfig();
      if (input.includes("/webhooks/")) {
        return `${config.webhookBaseUrl}${input}`;
      }
      return `${config.appUrl}${input}`;
    } catch {
      // If server config is not initialized, fallback to environment resolution below
    }
  }

  // Safe client or fallback resolution
  const env = process.env.NEXT_PUBLIC_VERCEL_ENV;
  let domain = "";
  if (process.env.NEXT_PUBLIC_APP_URL) {
    domain = process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  } else if (env === "production" && process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL) {
    domain = `https://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`;
  } else if (env === "preview" && process.env.NEXT_PUBLIC_VERCEL_URL) {
    domain = `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
  } else if (process.env.TUNNEL_URL) {
    domain = process.env.TUNNEL_URL.replace(/\/+$/, "");
  } else {
    domain = "http://localhost:3000";
  }

  return domain + input;
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
