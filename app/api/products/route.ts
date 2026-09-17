import { NextResponse } from "next/server";
import { ensureDatabaseInitialized, getBillingRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureDatabaseInitialized();
  const billingRepo = getBillingRepository();
  const products = await billingRepo.listActiveProductsWithPrices();

  return NextResponse.json({ products });
}
