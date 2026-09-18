import "server-only";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export function getVerifyToken() { return required("WHATSAPP_VERIFY_TOKEN"); }
export function getAppSecret() { return required("WHATSAPP_APP_SECRET"); }
export function getWhatsAppConfig() {
  const apiVersion = required("WHATSAPP_API_VERSION");
  const phoneNumberId = required("WHATSAPP_PHONE_NUMBER_ID");
  if (!/^v\d+\.0$/.test(apiVersion) || !/^\d+$/.test(phoneNumberId)) {
    throw new Error("Invalid WhatsApp API version or phone number ID");
  }
  return { apiVersion, phoneNumberId, accessToken: required("WHATSAPP_ACCESS_TOKEN") };
}
