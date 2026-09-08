"""Application checks for the unchanged generic NCP client."""

from ncp_local import modular_wire as w

from . import codec as c
from . import types as t


class SensorContract:
    @staticmethod
    def descriptor() -> bytes:
        return c._DESCRIPTOR

    @staticmethod
    def allows(operation: w.Name) -> bool:
        return operation in (w.Name.PREPARE, w.Name.APPLICATION, w.Name.READ, w.Name.RELEASE, w.Name.FINISH, w.Name.ABORT)

    @staticmethod
    def decode_prepare(value: object) -> t.Prepare:
        result = c.decode("Prepare", value)
        c.require(result.composition_digest == c.COMPOSITION_DIGEST, "binding")
        c.validate_specification(result.specification)
        return result

    @staticmethod
    def decode_command(value: object) -> t.Command:
        return c.decode("Command", value)

    @staticmethod
    def decode_finish(value: object) -> t.Finish:
        return c.decode("Finish", value)

    @staticmethod
    def decode_result(value: object) -> t.Prepared | t.Advanced:
        c.require(len(w.encode(value)) <= 32_768, "capacity")
        return c.decode("Result", value)

    @staticmethod
    def decode_terminal(value: object) -> t.Terminal:
        return c.decode("Terminal", value)

    @staticmethod
    def _uninhabited(*_: object) -> None:
        raise w.ModularError("wire")

    decode_import = _uninhabited
    decode_metadata = _uninhabited
    decode_imported = _uninhabited
    check_import_metadata = _uninhabited

    @staticmethod
    def check_input(operation: w.Operation) -> None:
        if type(operation) is w.Prepare:
            c.require(type(operation.data) is t.Prepare)
            SensorContract.decode_prepare(c.raw(operation.data))
        elif type(operation) is w.Application:
            c.require(type(operation.data) is t.Command)
            SensorContract.decode_command(c.raw(operation.data))
        elif type(operation) is w.Finish:
            c.require(type(operation.data) is t.Finish)
            SensorContract.decode_finish(c.raw(operation.data))
        else:
            c.require(type(operation) in (w.Read, w.Release, w.Abort))

    @staticmethod
    def check_response(operation: w.Operation, body: w.Body, context: object) -> None:
        if type(operation) is w.Prepare:
            c.require(type(body.data) is t.Prepared)
            c.validate_prepared(operation.data, body.data, context.binding)
        elif type(operation) is w.Application:
            c.require(type(body.data) is t.Advanced)
            result, command = body.data, operation.data
            c.require(result.tick == result.batch.body_tick == command.tick, "binding")
            c.require(result.batch.previous_batch_digest == command.previous_batch_digest, "binding")
            accepted = context.request_digest if type(command.action) is t.SetTarget else command.action.accepted_action_request_digest
            c.require(result.accepted_action_request_digest == accepted, "binding")
            c.validate_batch_envelope(result.batch, context)
        elif type(operation) is w.Finish:
            c.require(type(body.data) is t.Terminal)
            result, request = body.data, operation.data
            c.require((result.plan_digest, result.completed_ticks, result.last_batch_digest) ==
                      (request.plan_digest, request.completed_ticks, request.last_batch_digest), "binding")
            c.require(result.planned_ticks == result.completed_ticks, "binding")
