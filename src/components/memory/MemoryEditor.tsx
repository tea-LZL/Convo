import { Save } from "lucide-react";
import type { MemoryItem } from "../../lib/api";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Select, TextArea, TextInput } from "../ui/Form";
import { KIND_COLOR, KIND_LABEL, type MemoryKind } from "./MemoryLibrary";

export interface MemoryEditorDraft {
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string;
  is_enabled: boolean;
}

export interface MemoryEditorFieldsProps {
  draft: MemoryEditorDraft;
  onChange: (patch: Partial<MemoryEditorDraft>) => void;
  idPrefix: string;
  includeKind?: boolean;
  includeEnabled?: boolean;
  autoFocus?: boolean;
  labelPrefix?: string;
  disabled?: boolean;
}

const KIND_OPTIONS = [
  { value: "user_pref", label: KIND_LABEL.user_pref },
  { value: "project_fact", label: KIND_LABEL.project_fact },
  { value: "skill", label: KIND_LABEL.skill },
];

function fieldLabel(field: string, labelPrefix?: string) {
  return labelPrefix ? `${field} for ${labelPrefix}` : field;
}

export function MemoryEditorFields({
  draft,
  onChange,
  idPrefix,
  includeKind = false,
  includeEnabled = false,
  autoFocus = false,
  labelPrefix,
  disabled = false,
}: MemoryEditorFieldsProps) {
  return (
    <div className="space-y-2">
      {includeKind && (
        <div>
          <label htmlFor={`${idPrefix}-kind`} className="text-xs text-text-muted block mb-1">
            {fieldLabel("Kind", labelPrefix)}
          </label>
          <Select
            id={`${idPrefix}-kind`}
            value={draft.kind}
            disabled={disabled}
            onChange={(value) => onChange({ kind: value as MemoryKind })}
            options={KIND_OPTIONS}
          />
        </div>
      )}
      <div>
        <label htmlFor={`${idPrefix}-title`} className="text-xs text-text-muted block mb-1">
          {labelPrefix ? fieldLabel("Title", labelPrefix) : "Title (optional)"}
        </label>
        <TextInput
          id={`${idPrefix}-title`}
          value={draft.title}
          disabled={disabled}
          onChange={(title) => onChange({ title })}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-content`} className="text-xs text-text-muted block mb-1">
          {fieldLabel("Content", labelPrefix)}
        </label>
        <TextArea
          id={`${idPrefix}-content`}
          value={draft.content}
          disabled={disabled}
          onChange={(content) => onChange({ content })}
          rows={5}
          autoFocus={autoFocus}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-tags`} className="text-xs text-text-muted block mb-1">
          {labelPrefix ? fieldLabel("Tags", labelPrefix) : "Tags (comma-separated)"}
        </label>
        <TextInput
          id={`${idPrefix}-tags`}
          value={draft.tags}
          disabled={disabled}
          onChange={(tags) => onChange({ tags })}
          placeholder="preference, code-style, project-x"
        />
      </div>
      {includeEnabled && (
        <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={draft.is_enabled}
            disabled={disabled}
            onChange={(event) => onChange({ is_enabled: event.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          Include in chat context
        </label>
      )}
    </div>
  );
}

export interface MemoryEditorProps {
  open: boolean;
  item: MemoryItem | null;
  draft: MemoryEditorDraft;
  onChange: (patch: Partial<MemoryEditorDraft>) => void;
  onClose: () => void;
  onSave: () => void;
  saving?: boolean;
}

export function MemoryEditor({
  open,
  item,
  draft,
  onChange,
  onClose,
  onSave,
  saving = false,
}: MemoryEditorProps) {
  const handleClose = () => {
    if (!saving) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Edit memory"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            loading={saving}
            disabled={saving}
            icon={<Save size={12} />}
          >
            Save
          </Button>
        </>
      }
    >
      {item && (
        <div className="space-y-2">
          <div className="text-xs text-text-muted">
            <span className={`inline-block px-1.5 py-0.5 rounded border ${KIND_COLOR[item.kind] || KIND_COLOR.skill}`}>
              {KIND_LABEL[item.kind] || item.kind}
            </span>
          </div>
          <MemoryEditorFields
            draft={draft}
            onChange={onChange}
            idPrefix="memory"
            includeEnabled
            autoFocus
            disabled={saving}
          />
        </div>
      )}
    </Modal>
  );
}

export function memoryDraftFromItem(item: MemoryItem): MemoryEditorDraft {
  return {
    kind: item.kind,
    title: item.title ?? "",
    content: item.content,
    tags: item.tags ?? "",
    is_enabled: item.is_enabled,
  };
}

export function extractedFactToDraft(fact: { kind: string; title: string | null; content: string; tags: string | null }): MemoryEditorDraft {
  return {
    kind: fact.kind as MemoryKind,
    title: fact.title ?? "",
    content: fact.content,
    tags: fact.tags ?? "",
    is_enabled: true,
  };
}
