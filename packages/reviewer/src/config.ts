import Schema from "@deepseek-ai/schemastery";

type ObjectSchema = ReturnType<typeof Schema.object>;

const route = Schema.object({
    provider: Schema.string()
        .required()
        .description("Reviewer provider route."),
    model: Schema.string().required().description("Reviewer model id."),
    reasoningEffort: Schema.string()
        .default("")
        .description(
            "Adapter reasoning effort; empty uses the adapter default."
        ),
});

/** Validated reviewer configuration schema. */
export const Config: ObjectSchema = Schema.object({
    fast: route
        .required()
        .description("First review tier for every tool call."),
    strong: route
        .required()
        .description(
            "Second tier for denials, ambiguity, and privileged actions."
        ),
    timeoutMs: Schema.natural()
        .min(1)
        .default(30000)
        .description("Per-reviewer-call deadline in milliseconds."),
});
