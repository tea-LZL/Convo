import { PendingAttachment } from "../../hooks/useAttachments";

export const imageAttachment: PendingAttachment = {
  localId: "local-img-1",
  serverId: "server-img-1",
  name: "screenshot.png",
  mime: "image/png",
  size: 1_200_000,
  kind: "image",
  previewUrl: "blob://img-1",
  status: "ready",
};

export const documentAttachment: PendingAttachment = {
  localId: "local-doc-1",
  serverId: "server-doc-1",
  name: "notes.md",
  mime: "text/markdown",
  size: 4_000,
  kind: "document",
  previewUrl: null,
  status: "ready",
};

export const uploadingAttachment: PendingAttachment = {
  localId: "local-upload-1",
  serverId: null,
  name: "draft.txt",
  mime: "text/plain",
  size: 1_000,
  kind: "document",
  previewUrl: null,
  status: "uploading",
};

export const attachmentList = [imageAttachment, documentAttachment, uploadingAttachment];
