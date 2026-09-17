"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 flex items-center justify-center p-4 font-sans antialiased text-gray-900">
        <div className="max-w-md w-full p-8 bg-white border border-gray-200 rounded-2xl shadow-sm text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-xl">
            !
          </div>
          <h2 className="text-2xl font-bold mb-2">System Error</h2>
          <p className="text-sm text-gray-600 mb-6">
            A critical system error occurred. Please refresh or try again later.
          </p>
          {error.digest && (
            <div className="mb-6 p-2 bg-gray-50 rounded text-xs text-gray-500 font-mono">
              Incident ID: {error.digest}
            </div>
          )}
          <button
            onClick={() => reset()}
            className="w-full py-2.5 px-4 bg-black hover:bg-gray-800 text-white rounded-lg text-sm font-medium transition"
          >
            Refresh Application
          </button>
        </div>
      </body>
    </html>
  );
}
