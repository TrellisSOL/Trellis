{{/* Names and the checks every template relies on. */}}

{{- define "graft.fullname" -}}
{{- printf "%s-graft" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "graft.labels" -}}
app.kubernetes.io/name: graft
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "graft.selector" -}}
app.kubernetes.io/name: graft
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The sidecar image, refused unless pinned by digest. */}}
{{- define "graft.sidecarImage" -}}
{{- $img := required "sidecar.image is required (name@sha256:<64 hex>)" .Values.sidecar.image -}}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" $img) -}}
{{- fail "sidecar.image must be pinned by digest (name@sha256:<64 hex>)" -}}
{{- end -}}
{{- $img -}}
{{- end -}}

{{- define "graft.engineImage" -}}
{{- $img := required "engine.image is required (name@sha256:<64 hex>)" .Values.engine.image -}}
{{- if not (regexMatch "@sha256:[0-9a-f]{64}$" $img) -}}
{{- fail "engine.image must be pinned by digest (name@sha256:<64 hex>)" -}}
{{- end -}}
{{- $img -}}
{{- end -}}

{{/* Lanes other than public need Intel TDX, and so does a confidential-GPU claim (same rules as graft.schema.json). */}}
{{- define "graft.checkClaims" -}}
{{- $tee := .Values.graft.tee -}}
{{- range .Values.graft.lanes -}}
{{- if and (ne . "public") (ne $tee "tdx") -}}
{{- fail (printf "lane %s needs an Intel TDX host (graft.tee is %s)" . $tee) -}}
{{- end -}}
{{- end -}}
{{- if and (eq (toString .Values.graft.gpu.cc_mode) "on") (ne $tee "tdx") -}}
{{- fail "a confidential-GPU claim needs Intel TDX: SEV-SNP has no runtime measurement register to bind GPU evidence into" -}}
{{- end -}}
{{- if not (has .Values.sidecar.attestation (list "tdx" "dstack" "dev")) -}}
{{- fail "sidecar.attestation must be tdx, dstack or dev" -}}
{{- end -}}
{{- end -}}
