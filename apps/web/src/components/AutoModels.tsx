import { type ModelTier, useCredentials, useModels, useSettings, useUpdateSettings } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import {
  autoLineProvider,
  MODEL_TIERS,
  modelChoices,
  nearestTier,
  usableModels,
} from "@agenteschat/client/lib/providers";
import { Button, Dialog, DialogBody, DialogFooter, Field, Locked, ProviderLogo, SettingRow } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelSelect, modelOptions } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** The choice that leaves a tier on its default. */
const DEFAULT = "";

/**
 * "Modelos do Automático": which model each size of task gets. The tiers are kept under the workspace default key's
 * provider (`autoModels[provider]`, ADR 0087), and a tier may name a model of any connected key, grouped by key; one left
 * on "Padrão" follows that provider's good pick for it.
 */
export function AutoModelsRow() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const models = useModels();
  const settings = useSettings(org.id);
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const update = useUpdateSettings(org.id);
  const toast = useToast();
  const [chosen, setChosen] = useState<Record<ModelTier, string> | null>(null);
  const all = models.data?.models ?? [];
  const keys = credentials.data ?? [];
  const PROVIDER = autoLineProvider(keys, settings.data?.defaultCredentialId);
  const choices = modelChoices(all, keys, false);
  const own = all.filter((m) => m.provider === PROVIDER && !m.endpoint);
  if (!can(org, "configure") || !PROVIDER || choices.length === 0 || !settings.data) return null;
  const saved = settings.data.autoModels[PROVIDER] ?? {};
  const usable = usableModels(choices);
  // A model its key no longer offers: the tier runs on its default, so it shows as the default.
  const start = Object.fromEntries(
    MODEL_TIERS.map((tier) => [tier, saved[tier] && usable.has(saved[tier]) ? saved[tier] : DEFAULT]),
  ) as Record<ModelTier, string>;
  const options = modelOptions(t, i18n.language, choices);
  const save = () => {
    if (!chosen) return;
    // Only the tiers that changed: one left alone is never refused for a model gone from the list.
    const changed = MODEL_TIERS.filter((tier) => (chosen[tier] || undefined) !== saved[tier]);
    const tiers = Object.fromEntries(changed.map((tier) => [tier, chosen[tier] || null]));
    update.mutate(
      { autoModels: { [PROVIDER]: tiers } },
      {
        onSuccess: () => {
          toast.show(t("settings.autoModels.saved"));
          setChosen(null);
        },
      },
    );
  };
  return (
    <>
      <SettingRow
        title={t("settings.autoModels.title")}
        hint={{
          name: t("common.about", { label: t("settings.autoModels.title") }),
          text: t("settings.autoModels.text"),
        }}
      >
        <Button size="sm" onClick={() => setChosen(start)}>
          <ProviderLogo id={PROVIDER} size="xs" />
          {t("settings.autoModels.choose")}
        </Button>
      </SettingRow>
      <Dialog
        open={chosen !== null}
        onOpenChange={(o) => !o && setChosen(null)}
        title={t("settings.autoModels.title")}
        description={t("settings.autoModels.text")}
        closeLabel={t("common.close")}
        width={520}
      >
        <Locked when={update.isPending}>
          <DialogBody>
            {MODEL_TIERS.map((tier) => {
              const fallback = nearestTier(own, tier, (m) => m.tier);
              return (
                <Field key={tier} label={t(`settings.autoModels.${tier}`)} id={`auto-model-${tier}`}>
                  <ModelSelect
                    value={chosen?.[tier] ?? DEFAULT}
                    onChange={(model) => setChosen((c) => c && { ...c, [tier]: model })}
                    options={[
                      {
                        value: DEFAULT,
                        label: fallback
                          ? t("settings.autoModels.default", { model: fallback.label })
                          : t("brain.auto.label"),
                        leading: <ProviderLogo id={PROVIDER} size="sm" />,
                      },
                      ...options,
                    ]}
                  />
                </Field>
              );
            })}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={() => setChosen(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
