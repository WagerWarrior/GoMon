import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
/** Old workspace links land on the session's live tab. */
export default async function CallPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  redirect(`/sessions/${callId}?tab=live`);
}
