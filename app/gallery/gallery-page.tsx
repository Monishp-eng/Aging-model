"use client";

import Balancer from "react-wrap-balancer";
import PhotoBooth from "@/components/home/photo-booth";
import { useRouter } from "next/navigation";
import { DataProps } from "@/lib/types";

export function GalleryPage({ data }: { data: DataProps[] | null }) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center justify-center">
      <div className="bg-gradient-to-br from-black to-stone-500 bg-clip-text text-center font-display text-4xl font-bold tracking-[-0.02em] text-transparent drop-shadow-sm md:text-7xl md:leading-[5rem]">
        <Balancer>Gallery</Balancer>
      </div>
      <div className="grid w-full gap-4 px-4 sm:grid-cols-2">
        {data?.map((row) => (
          <div
            key={row.id}
            className="cursor-pointer transition-all hover:scale-[1.01]"
            onClick={() => router.push(`/p/${row.id}`)}
          >
            <PhotoBooth
              id={row.id}
              input={row.input}
              output={row.output}
              failed={row.failed}
              expired={row.expired}
              initialState={0}
              className="h-full"
            />
          </div>
        ))}
      </div>
      {(!data || data.length === 0) && (
        <div className="mt-12 flex max-w-md flex-col items-center justify-center rounded-2xl border border-gray-200 bg-white/80 p-8 text-center shadow-sm backdrop-blur-sm">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-600">
            <svg
              className="h-7 w-7"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h3 className="mt-4 text-lg font-semibold text-gray-900">
            No photos yet
          </h3>
          <p className="mt-2 text-sm text-gray-500">
            Upload your first photo to see how AI transforms your face through the decades.
          </p>
          <button
            onClick={() => router.push("/")}
            className="mt-6 inline-flex items-center rounded-full border border-primary bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            Create Your First Aging Photo
          </button>
        </div>
      )}
    </div>
  );
}
