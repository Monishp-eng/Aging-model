import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthenticatedUser();

  if (!auth) {
    return NextResponse.json({ user: null }, { status: 200 });
  }

  const user = auth.user;

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      credits: user.credits_balance,
      stripe_id: user.stripe_customer_id,
    },
  });
}
