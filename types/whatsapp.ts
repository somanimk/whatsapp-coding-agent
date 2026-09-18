export interface IncomingTextMessage {
  id: string;
  from: string;
  text: string;
}
export interface WhatsAppTextRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: { preview_url: false; body: string };
}
