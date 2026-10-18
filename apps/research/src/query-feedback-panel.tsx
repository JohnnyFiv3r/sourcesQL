import type { QueryFeedback } from "./query-feedback.js";

/** Read-only feedback about the saved query, independent of host or network access. */
export function QueryFeedbackPanel({ feedback }: { feedback?: QueryFeedback }) {
  if (!feedback)
    return (
      <div className="query-feedback">
        <p>No query description was recorded for this saved table.</p>
        <p className="muted-note">
          You can still explore its results and sources.
        </p>
      </div>
    );

  const description =
    feedback.description_status === "available"
      ? feedback.description
      : undefined;
  const intent =
    feedback.intent_status === "provided" ? feedback.answer_intent : undefined;
  const observations = feedback.result_observations;

  return (
    <div className="query-feedback">
      <p className="muted-note">
        This describes the saved query and its returned data. It does not verify
        factual accuracy or complete coverage. Later corrections may differ.
      </p>

      <section aria-labelledby="query-feedback-intent-title">
        <h3 id="query-feedback-intent-title">Intended answer</h3>
        {intent ? (
          <>
            {intent.question && <p>{intent.question}</p>}
            <p>
              <span className="query-feedback-label">One row represents:</span>{" "}
              {intent.row_unit}
            </p>
            <dl className="query-feedback-fields">
              {intent.fields.map((field) => (
                <div key={field.key}>
                  <dt>
                    <code>{field.key}</code>
                  </dt>
                  <dd>{field.meaning}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="muted-note">
            {feedback.intent_status === "invalid"
              ? "The recorded intended answer could not be read."
              : "No intended answer was recorded for this table."}
          </p>
        )}
      </section>

      <section aria-labelledby="query-feedback-query-title">
        <h3 id="query-feedback-query-title">Actual query</h3>
        {description ? (
          <>
            <p>{description.summary}</p>
            {description.steps.length > 0 && (
              <details className="query-feedback-details">
                <summary>Query steps ({description.steps.length})</summary>
                <ol className="query-feedback-steps">
                  {description.steps.map((step, index) => (
                    <li key={index}>
                      <span className="query-feedback-scope">{step.scope}</span>
                      <p>{step.text}</p>
                      {step.sql && (
                        <pre>
                          <code>{step.sql}</code>
                        </pre>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {description.omitted_steps > 0 && (
              <p className="muted-note">
                {description.omitted_steps} additional query{" "}
                {description.omitted_steps === 1 ? "step is" : "steps are"} not
                included in this description.
              </p>
            )}
          </>
        ) : (
          <p className="muted-note">
            A plain-language description is unavailable for this query. Its
            recorded result observations are shown below when available.
          </p>
        )}
        <p className="query-feedback-label">Returned columns</p>
        {feedback.output_columns.length > 0 ? (
          <ul className="query-feedback-columns">
            {feedback.output_columns.map((column) => (
              <li key={column}>
                <code>{column}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-note">No output columns were recorded.</p>
        )}
      </section>

      {(feedback.missing_intended_fields.length > 0 || observations) && (
        <section aria-labelledby="query-feedback-observations-title">
          <h3 id="query-feedback-observations-title">Result observations</h3>
          {feedback.missing_intended_fields.length > 0 && (
            <>
              <p>Requested fields absent from the returned columns:</p>
              <ul className="query-feedback-columns">
                {feedback.missing_intended_fields.map((field) => (
                  <li key={field}>
                    <code>{field}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {observations && (
            <>
              <p>
                The query returned {observations.row_count}{" "}
                {observations.row_count === 1 ? "row" : "rows"}.
              </p>
              {observations.null_cells.length > 0 && (
                <>
                  <p>Empty cells at query completion:</p>
                  <dl className="query-feedback-fields query-feedback-null-cells">
                    {observations.null_cells.map((cell) => (
                      <div key={cell.key}>
                        <dt>
                          <code>{cell.key}</code>
                        </dt>
                        <dd>{cell.count}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="muted-note">
                    An empty cell can mean the answer was not stated or was
                    unavailable. It does not make the other results invalid.
                  </p>
                </>
              )}
            </>
          )}
        </section>
      )}

      <details className="query-feedback-details">
        <summary>Query identifiers</summary>
        <p className="muted-note">
          These hashes identify the query and its recorded inputs. They do not
          certify the answer.
        </p>
        <dl className="query-feedback-fields query-feedback-hashes">
          <div>
            <dt>SQL hash</dt>
            <dd>
              <code>{feedback.query_sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Parameter hash</dt>
            <dd>
              <code>{feedback.parameters_sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Input versions hash</dt>
            <dd>
              <code>{feedback.input_pins_sha256}</code>
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
