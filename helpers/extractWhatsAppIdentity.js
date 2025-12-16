const extractWhatsAppIdentity = (payload) => {
  const value = payload.entry?.[0]?.changes?.[0]?.value;

  const waId = value?.contacts?.[0]?.wa_id || null;
  const from = value?.messages?.[0]?.from || null;

  const rawNumber = waId || from;

  return {
    waId: waId || null,
    whatsAppE164: rawNumber ? `+${rawNumber}` : null,
    profileName: value?.contacts?.[0]?.profile?.name || null,
  };
};
