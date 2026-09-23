"""Independent closed city contract for the unchanged public NCP client."""

from ncp_local import modular_wire as w
from . import codec as c, types as t


class CityContract:
    @staticmethod
    def descriptor() -> bytes:
        return c._DESCRIPTOR

    @staticmethod
    def allows(operation: w.Name) -> bool:
        return operation in (
            w.Name.PREPARE,
            w.Name.APPLICATION,
            w.Name.READ,
            w.Name.RELEASE,
            w.Name.FINISH,
            w.Name.ABORT,
        )

    @staticmethod
    def decode_prepare(value):
        result = c.decode("Prepare", value)
        c.validate_prepare(result)
        return result

    @staticmethod
    def decode_command(value):
        return c.decode("Command", value)

    @staticmethod
    def decode_finish(value):
        return c.decode("Finish", value)

    @staticmethod
    def decode_result(value):
        c.require(len(w.encode(value)) <= 49152, "capacity")
        return c.decode("Result", value)

    @staticmethod
    def decode_terminal(value):
        return c.decode("Terminal", value)

    @staticmethod
    def _uninhabited(*_):
        raise w.ModularError("wire")

    decode_import = _uninhabited
    decode_metadata = _uninhabited
    decode_imported = _uninhabited
    check_import_metadata = _uninhabited

    @staticmethod
    def check_input(operation):
        if type(operation) is w.Prepare:
            c.require(type(operation.data) in t.PREPARE_CLASSES.values())
            CityContract.decode_prepare(c.raw(operation.data))
        elif type(operation) is w.Application:
            c.require(
                type(operation.data) in (t.Advance, t.ExportSource, t.ReleaseBatch)
            )
            CityContract.decode_command(c.raw(operation.data))
        elif type(operation) is w.Finish:
            c.require(type(operation.data) is t.Finish)
            CityContract.decode_finish(c.raw(operation.data))
        else:
            c.require(type(operation) in (w.Read, w.Release, w.Abort))

    @staticmethod
    def check_response(operation, body, context):
        if type(operation) is w.Prepare:
            c.require(type(body.data) is t.Prepared)
            c.validate_prepared(operation.data, body.data, context.binding)
        elif type(operation) is w.Application:
            command, result = operation.data, body.data
            if type(command) is t.Advance:
                c.require(type(result) in (t.Advanced, t.AdvanceFailed))
                b = result.batch
                c.require(
                    b.plan_digest == command.plan_digest
                    and b.roster_digest == command.roster_digest,
                    "binding",
                )
                c.require(
                    b.tick == b.control.tick == command.tick
                    and b.previous_batch_digest == command.previous_batch_digest,
                    "binding",
                )
                c.require(
                    len(b.control.rows) == len(command.rows)
                    and all(row[0] == i for i, row in enumerate(b.control.rows)),
                    "binding",
                )
                c.require(b.batch_digest == c.commitment("batch", c.raw(b)), "binding")
                failed = sum(type(slot) is t.Failed for slot in b.slots)
                c.require(
                    failed == (1 if type(result) is t.AdvanceFailed else 0), "binding"
                )
                c.require(
                    type(result) is t.AdvanceFailed
                    or all(type(slot) in (t.Produced, t.NotDue) for slot in b.slots),
                    "binding",
                )
            elif type(command) is t.ExportSource:
                c.require(type(result) is t.Exported)
                c.validate_export(result, command, context)
            else:
                c.require(
                    type(command) is t.ReleaseBatch and type(result) is t.BatchReleased
                )
                c.require(
                    (result.plan_digest, result.batch_digest, result.tick)
                    == (command.plan_digest, command.batch_digest, command.tick),
                    "binding",
                )
        elif type(operation) is w.Finish:
            result, request = body.data, operation.data
            c.require(type(result) is t.Terminal)
            c.require(
                (
                    result.plan_digest,
                    result.completed_ticks,
                    result.last_released_batch_digest,
                )
                == (
                    request.plan_digest,
                    request.completed_ticks,
                    request.last_released_batch_digest,
                ),
                "binding",
            )
